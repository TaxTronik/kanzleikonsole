import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DeleteObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';

const h = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('../client', () => ({
  s3: { send: h.send },
  classificationToTier: vi.fn(() => 'GOBD'),
  getBucketForTier: vi.fn((tier: string) => `bucket-${tier.toLowerCase()}`),
}));

import {
  commitBytesWithTier,
  commitPreparedBytes,
  deleteObjectVersion,
  prepareBytesCommitWithTier,
  recoverPreparedBytesCommit,
} from '../service';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('S3-Objektversionen', () => {
  it('übernimmt die VersionId eines geschützten Uploads in das Commit-Ergebnis', async () => {
    h.send.mockResolvedValueOnce({ VersionId: 'version-123' });

    const result = await commitBytesWithTier({
      fileData: Buffer.from('intern erzeugter Beleg'),
      tier: 'GOBD',
      tenantId: 'tenant-1',
      skipScan: true,
      classification: 'GOBD_INVOICE',
    });

    expect(result.storageVersionId).toBe('version-123');
    expect(h.send.mock.calls[0]![0]).toBeInstanceOf(PutObjectCommand);
  });

  it('persistiert einen vorbereitbaren Schlüssel vor dem eigentlichen Upload', async () => {
    const bytes = Buffer.from('%PDF-1.7\nVollmacht');
    const prepared = await prepareBytesCommitWithTier({
      fileData: bytes,
      tier: 'GOBD',
      tenantId: 'tenant-1',
      skipScan: true,
      classification: 'GOBD_CONTRACT',
    });

    expect(h.send).not.toHaveBeenCalled();
    expect(prepared.targetKey).toMatch(/^tenants\/tenant-1\/gobd\//);

    h.send.mockResolvedValueOnce({ VersionId: 'version-prepared' });
    const result = await commitPreparedBytes({ fileData: bytes, prepared });

    const put = h.send.mock.calls[0]![0] as PutObjectCommand;
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect(put.input.Bucket).toBe(prepared.targetBucket);
    expect(put.input.Key).toBe(prepared.targetKey);
    expect(put.input.Body).toBe(bytes);
    expect(put.input.IfNoneMatch).toBe('*');
    expect(put.input.ObjectLockMode).toBe('COMPLIANCE');
    expect(put.input.ObjectLockRetainUntilDate).toEqual(prepared.retentionUntil);
    expect(result).toEqual(
      expect.objectContaining({
        targetKey: prepared.targetKey,
        storageVersionId: 'version-prepared',
      }),
    );
  });

  it('weist nach dem Prepare veränderte Bytes vor dem Object Store ab', async () => {
    const prepared = await prepareBytesCommitWithTier({
      fileData: Buffer.from('%PDF-1.7\nOriginal'),
      tier: 'GOBD',
      tenantId: 'tenant-1',
      skipScan: true,
    });

    await expect(
      commitPreparedBytes({ fileData: Buffer.from('%PDF-1.7\nManipuliert'), prepared }),
    ).rejects.toThrow('PREPARED_UPLOAD_MISMATCH');
    expect(h.send).not.toHaveBeenCalled();
  });

  it('übernimmt nach verlorener PUT-Antwort exakt die bereits gespeicherte Version', async () => {
    const bytes = Buffer.from('%PDF-1.7\nVollmacht');
    const prepared = await prepareBytesCommitWithTier({
      fileData: bytes,
      tier: 'GOBD',
      tenantId: 'tenant-1',
      skipScan: true,
    });
    h.send
      .mockRejectedValueOnce(new Error('PUT response lost'))
      .mockResolvedValueOnce({
        IsTruncated: false,
        Versions: [{ Key: prepared.targetKey, VersionId: 'version-recovered', IsLatest: true }],
      })
      .mockResolvedValueOnce({
        ContentLength: bytes.length,
        Body: Readable.from([bytes]),
      });

    const result = await commitPreparedBytes({ fileData: bytes, prepared });

    expect(result.storageVersionId).toBe('version-recovered');
    const put = h.send.mock.calls[0]![0] as PutObjectCommand;
    expect(put.input.IfNoneMatch).toBe('*');
    const get = h.send.mock.calls[2]![0] as { input: Record<string, unknown> };
    expect(get.input).toEqual({
      Bucket: prepared.targetBucket,
      Key: prepared.targetKey,
      VersionId: 'version-recovered',
    });
  });

  it('bricht bei mehreren Versionen unter demselben Intent-Key fail-closed ab', async () => {
    const prepared = await prepareBytesCommitWithTier({
      fileData: Buffer.from('%PDF-1.7\nVollmacht'),
      tier: 'GOBD',
      tenantId: 'tenant-1',
      skipScan: true,
    });
    h.send.mockResolvedValueOnce({
      IsTruncated: false,
      Versions: [
        { Key: prepared.targetKey, VersionId: 'version-1' },
        { Key: prepared.targetKey, VersionId: 'version-2' },
      ],
    });

    await expect(recoverPreparedBytesCommit(prepared)).rejects.toThrow(
      'PREPARED_UPLOAD_MULTIPLE_VERSIONS',
    );
  });

  it('findet die Upload-Version auch auf einer paginierten Folgeseite', async () => {
    h.send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        IsTruncated: true,
        NextKeyMarker: 'tenant/document.bin',
        NextVersionIdMarker: 'older-version',
        Versions: [],
      })
      .mockImplementationOnce(async (command: ListObjectVersionsCommand) => ({
        IsTruncated: false,
        Versions: [
          {
            Key: command.input.Prefix,
            IsLatest: true,
            VersionId: 'version-from-page-2',
          },
        ],
      }));

    const result = await commitBytesWithTier({
      fileData: Buffer.from('intern erzeugter Beleg'),
      tier: 'GOBD',
      tenantId: 'tenant-1',
      skipScan: true,
    });

    expect(result.storageVersionId).toBe('version-from-page-2');
    const secondList = h.send.mock.calls[2]![0] as ListObjectVersionsCommand;
    expect(secondList.input.KeyMarker).toBe('tenant/document.bin');
    expect(secondList.input.VersionIdMarker).toBe('older-version');
  });

  it('löscht exakt per VersionId und verifiziert die vollständige Abwesenheit', async () => {
    h.send.mockResolvedValueOnce({}).mockResolvedValueOnce({ Versions: [], DeleteMarkers: [] });

    await deleteObjectVersion('gwg', 'tenant/document.bin', 'version-123', {
      bypassGovernanceRetention: true,
    });

    const deleteCommand = h.send.mock.calls[0]![0] as DeleteObjectCommand;
    expect(deleteCommand).toBeInstanceOf(DeleteObjectCommand);
    expect(deleteCommand.input).toEqual({
      Bucket: 'gwg',
      Key: 'tenant/document.bin',
      VersionId: 'version-123',
      BypassGovernanceRetention: true,
    });
    expect(h.send.mock.calls[1]![0]).toBeInstanceOf(ListObjectVersionsCommand);
  });

  it('akzeptiert andere legitime Versionen desselben Schlüssels', async () => {
    h.send.mockResolvedValueOnce({}).mockResolvedValueOnce({
      Versions: [{ Key: 'tenant/document.bin', VersionId: 'older-version' }],
      DeleteMarkers: [],
    });

    await expect(
      deleteObjectVersion('gwg', 'tenant/document.bin', 'version-123'),
    ).resolves.toBeUndefined();
  });

  it('prüft auch Folgeseiten auf die verbliebene Zielversion', async () => {
    h.send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        IsTruncated: true,
        NextKeyMarker: 'tenant/document.bin',
        NextVersionIdMarker: 'older-version',
        Versions: [],
        DeleteMarkers: [],
      })
      .mockResolvedValueOnce({
        IsTruncated: false,
        Versions: [{ Key: 'tenant/document.bin', VersionId: 'version-123' }],
      });

    await expect(deleteObjectVersion('gwg', 'tenant/document.bin', 'version-123')).rejects.toThrow(
      'STORAGE_DELETE_INCOMPLETE',
    );
  });
});
