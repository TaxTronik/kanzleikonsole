// Fachkatalog: POA-SIGNING-SNAPSHOT-001, DOC-VERSION-IMMUTABILITY-001
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { GetObjectCommand } from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const TOKEN = 'snapshot-token';
const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';
const VERSION_ID = '22222222-2222-4222-8222-222222222222';
const DOCUMENT_BYTES = Buffer.from('%PDF-1.7 Vollmacht Finanzamt');
const DOCUMENT_SHA256 = createHash('sha256').update(DOCUMENT_BYTES).digest();

const snapshot = JSON.stringify({
  schemaVersion: 1,
  subject: 'Vollmacht Finanzamt',
  signerName: 'Sina Signer',
  signerEmail: 'signer@example.de',
  validFrom: '2026-08-01',
  validUntil: '2099-08-01',
  scope: null,
  document: {
    documentId: DOCUMENT_ID,
    versionId: VERSION_ID,
    sha256: DOCUMENT_SHA256.toString('hex'),
  },
});

const m = vi.hoisted(() => ({
  checkIpOrGlobalLimit: vi.fn(),
  getClientIp: vi.fn(),
  poaFindFirst: vi.fn(),
  versionFindFirst: vi.fn(),
  send: vi.fn(),
}));

vi.mock('@/server/rate-limit', () => ({
  checkIpOrGlobalLimit: m.checkIpOrGlobalLimit,
  getClientIp: m.getClientIp,
}));
vi.mock('@/server/db/prisma-owner', () => ({
  prismaOwner: {
    powerOfAttorney: { findFirst: m.poaFindFirst },
    documentVersion: { findFirst: m.versionFindFirst },
  },
}));
// R-05: S3 ist am Storage-Client gemockt; der geprüfte Leseweg läuft echt.
vi.mock('@taxtronik/storage/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@taxtronik/storage/client')>()),
  s3: { send: m.send },
}));

import { GET } from '../route';

beforeEach(() => {
  vi.clearAllMocks();
  m.checkIpOrGlobalLimit.mockResolvedValue({ ok: true });
  m.getClientIp.mockReturnValue('198.51.100.7');
  m.poaFindFirst.mockResolvedValue({
    id: 'poa-1',
    tenantId: 'tenant-1',
    documentId: DOCUMENT_ID,
    status: 'SENT',
    signingTokenExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
    signingContentSnapshot: snapshot,
    signingContentSha256: createHash('sha256').update(snapshot).digest(),
    signingDocumentVersionId: VERSION_ID,
  });
  m.versionFindFirst.mockResolvedValue({
    id: VERSION_ID,
    documentId: DOCUMENT_ID,
    sha256: DOCUMENT_SHA256,
    sizeBytes: BigInt(DOCUMENT_BYTES.length),
    storageBucket: 'docs-gobd',
    storageKey: 'tenant-1/poa/version-1.pdf',
    storageVersionId: 'bound-s3-version',
    scanStatus: 'CLEAN',
    scanCompletedAt: new Date('2026-08-01'),
    document: {
      id: DOCUMENT_ID,
      tenantId: 'tenant-1',
      title: 'Vollmacht.pdf',
      mimeType: 'application/pdf',
      classification: 'GOBD_CONTRACT',
      deletedAt: null,
    },
  });
  m.send.mockImplementation(async () => ({
    Body: Readable.from([Buffer.from(DOCUMENT_BYTES)]),
    ContentLength: DOCUMENT_BYTES.length,
  }));
});

const call = () => GET(new NextRequest(`http://localhost:3000/poa/sign/document?token=${TOKEN}`));

describe('GET /poa/sign/document — Versand-Snapshot', () => {
  it('liefert ausschließlich die beim Versand gebundene Version', async () => {
    const response = await GET(
      new NextRequest(`http://localhost:3000/poa/sign/document?token=${TOKEN}`),
    );

    expect(response.status).toBe(200);
    expect(m.versionFindFirst).toHaveBeenCalledWith({
      where: {
        id: VERSION_ID,
        documentId: DOCUMENT_ID,
        document: { tenantId: 'tenant-1', deletedAt: null },
      },
      include: { document: true },
    });
    expect((m.send.mock.calls[0]![0] as GetObjectCommand).input).toEqual({
      Bucket: 'docs-gobd',
      Key: 'tenant-1/poa/version-1.pdf',
      VersionId: 'bound-s3-version',
    });
    expect(response.headers.get('content-length')).toBe(String(DOCUMENT_BYTES.length));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(DOCUMENT_BYTES);
  });

  // R-05: Der Unterzeichner erhält nur Bytes, die Größe und SHA-256 der im
  // Signatur-Snapshot gebundenen Version entsprechen.
  it('bricht die Auslieferung bei abweichenden Bytes gleicher Länge ab', async () => {
    const tampered = Buffer.from(DOCUMENT_BYTES);
    tampered[tampered.length - 1] = 0x21;
    m.send.mockImplementation(async () => ({
      Body: Readable.from([tampered]),
      ContentLength: tampered.length,
    }));

    const response = await call();

    await expect(response.arrayBuffer()).rejects.toMatchObject({
      name: 'StoredObjectError',
      reason: 'HASH_MISMATCH',
    });
  });

  it('liefert bei abweichender angekündigter Länge kein Byte aus', async () => {
    m.send.mockImplementation(async () => ({
      Body: Readable.from([Buffer.from(DOCUMENT_BYTES)]),
      ContentLength: DOCUMENT_BYTES.length + 1,
    }));

    await expect(call()).rejects.toMatchObject({
      name: 'StoredObjectError',
      reason: 'LENGTH_MISMATCH',
    });
  });

  it.each(['PENDING', 'INFECTED', 'ERROR', 'UNFINISHED'])(
    'POA-SIGNING-SNAPSHOT-001: verweigert nachträglich gesperrten oder unvollständigen Snapshot (%s)',
    async (state) => {
      const version = await m.versionFindFirst();
      m.versionFindFirst.mockResolvedValue({
        ...version,
        scanStatus: state === 'UNFINISHED' ? 'CLEAN' : state,
        scanCompletedAt: state === 'UNFINISHED' ? null : version.scanCompletedAt,
      });
      const response = await GET(
        new NextRequest(`http://localhost:3000/poa/sign/document?token=${TOKEN}`),
      );
      expect(response.status).toBe(404);
      expect(m.send).not.toHaveBeenCalled();
    },
  );
});
