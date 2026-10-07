// Fachkatalog: DOC-VERSION-IMMUTABILITY-001
// =============================================================================
// R-05: Der Abruf einer Wissensanlage streamt über den gemeinsamen, prüfenden
// Leseweg (streamVerifiedObject). S3 ist am Storage-Client gemockt; Größen- und
// SHA-256-Prüfung laufen echt.
// =============================================================================

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { GetObjectCommand } from '@aws-sdk/client-s3';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ findFirst: vi.fn(), record: vi.fn(), send: vi.fn() }));

vi.mock('@/server/actions/staff-action', () => ({
  staffActionGuard: async () => ({
    ok: true,
    tenantId: 'tenant-1',
    staffId: 'staff-1',
    ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
  }),
}));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: async (_ctx: unknown, run: (tx: unknown) => unknown) =>
    run({ kbAttachment: { findFirst: h.findFirst } }),
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.record } }));
vi.mock('@taxtronik/storage/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@taxtronik/storage/client')>()),
  s3: { send: h.send },
}));

import { GET } from '../route';

const ATTACHMENT_ID = '11111111-1111-4111-8111-111111111111';
const BYTES = Buffer.from('%PDF-1.7 Arbeitshilfe');

const entry = () => ({
  id: ATTACHMENT_ID,
  articleId: 'article-1',
  uploadedBy: 'staff-2',
  displayName: 'Arbeitshilfe',
  document: {
    title: 'Arbeitshilfe',
    mimeType: 'application/pdf',
    classification: 'GENERAL',
    deletedAt: null,
    versions: [
      {
        storageBucket: 'general',
        storageKey: 'tenants/tenant-1/none/2026/10/kb.bin',
        storageVersionId: 'kb-version',
        sha256: createHash('sha256').update(BYTES).digest(),
        sizeBytes: BigInt(BYTES.length),
        scanStatus: 'CLEAN',
        scanCompletedAt: new Date(),
      },
    ],
  },
});

function stored(bytes: Buffer, contentLength = bytes.length) {
  h.send.mockResolvedValueOnce({ Body: Readable.from([bytes]), ContentLength: contentLength });
}

const call = () =>
  GET(new NextRequest(`https://local.test/api/staff/knowledge/attachments/${ATTACHMENT_ID}`), {
    params: Promise.resolve({ id: ATTACHMENT_ID }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  h.findFirst.mockResolvedValue(entry());
  h.record.mockResolvedValue({});
});

describe('Wissensanlage über den geprüften Leseweg (R-05)', () => {
  it('liefert die Bytes der gebundenen Fassung nach Größen- und SHA-256-Prüfung', async () => {
    stored(BYTES);

    const response = await call();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe(String(BYTES.length));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(BYTES);
    expect((h.send.mock.calls[0]![0] as GetObjectCommand).input).toEqual({
      Bucket: 'general',
      Key: 'tenants/tenant-1/none/2026/10/kb.bin',
      VersionId: 'kb-version',
    });
  });

  it('bricht die Antwort bei abweichenden Bytes gleicher Länge ab', async () => {
    const tampered = Buffer.from(BYTES);
    tampered[tampered.length - 1] = 0x21;
    stored(tampered);

    const response = await call();

    await expect(response.arrayBuffer()).rejects.toMatchObject({
      name: 'StoredObjectError',
      reason: 'HASH_MISMATCH',
    });
  });

  it('liefert bei abweichender angekündigter Länge kein Byte aus', async () => {
    stored(BYTES, BYTES.length + 1);

    await expect(call()).rejects.toMatchObject({
      name: 'StoredObjectError',
      reason: 'LENGTH_MISMATCH',
    });
  });

  it('liest eine nicht freigegebene Anlage nicht aus dem Speicher', async () => {
    const pending = entry();
    pending.document.versions[0]!.scanStatus = 'PENDING';
    h.findFirst.mockResolvedValue(pending);

    expect((await call()).status).toBe(404);
    expect(h.send).not.toHaveBeenCalled();
  });
});
