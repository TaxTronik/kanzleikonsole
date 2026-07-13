import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DeleteObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';

const h = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('../client', () => ({
  s3: { send: h.send },
  classificationToTier: vi.fn(() => 'GOBD'),
  getBucketForTier: vi.fn((tier: string) => `bucket-${tier.toLowerCase()}`),
}));

import { commitBytesWithTier, deleteObjectVersion } from '../service';

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

  it('bricht fail-closed ab, wenn nach dem Delete noch eine Version existiert', async () => {
    h.send.mockResolvedValueOnce({}).mockResolvedValueOnce({
      Versions: [{ Key: 'tenant/document.bin', VersionId: 'older-version' }],
      DeleteMarkers: [],
    });

    await expect(deleteObjectVersion('gwg', 'tenant/document.bin', 'version-123')).rejects.toThrow(
      'STORAGE_DELETE_INCOMPLETE',
    );
  });

  it('prüft auch Folgeseiten auf verbliebene Versionen', async () => {
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
        Versions: [{ Key: 'tenant/document.bin', VersionId: 'oldest-version' }],
      });

    await expect(deleteObjectVersion('gwg', 'tenant/document.bin', 'version-123')).rejects.toThrow(
      'STORAGE_DELETE_INCOMPLETE',
    );
  });
});
