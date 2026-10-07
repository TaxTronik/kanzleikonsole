// Fachkatalog: DOC-VERSION-IMMUTABILITY-001
// =============================================================================
// R-05: Einzel- und Sammel-Download lesen über den gemeinsamen, prüfenden
// Leseweg (streamVerifiedObject). S3 ist am Storage-Client gemockt; Größen- und
// SHA-256-Prüfung laufen echt. Weichen Bytes von der gebundenen Fassung ab,
// bricht die Antwort ab — ein ZIP mit abweichenden Bytes entsteht nie.
// =============================================================================

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { GetObjectCommand } from '@aws-sdk/client-s3';
import { unzipSync } from 'fflate';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ read: vi.fn(), audit: vi.fn(), send: vi.fn() }));

vi.mock('@/server/auth/staff', () => ({
  staffAuth: async () => ({ user: { tenantId: 'tenant-1', staffId: 'staff-1' } }),
}));
vi.mock('@/server/auth/rbac', () => ({ accessibleClientsWhereFor: async () => ({}) }));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: async (_ctx: unknown, run: (tx: unknown) => unknown) =>
    run({ document: { findMany: h.read }, documentFolder: { findMany: async () => [] } }),
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.audit } }));
vi.mock('@/server/rate-limit', () => ({ getClientIp: () => '127.0.0.1' }));
vi.mock('@taxtronik/storage/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@taxtronik/storage/client')>()),
  s3: { send: h.send },
}));

import { GET } from '../download/route';

const ID_A = '00000000-0000-4000-8000-00000000000a';
const ID_B = '00000000-0000-4000-8000-00000000000b';
const CONTENT: Record<string, Buffer> = {
  [ID_A]: Buffer.from('%PDF-1.7 Beleg A'),
  [ID_B]: Buffer.from('%PDF-1.7 Beleg B'),
};

function doc(id: string) {
  const bytes = CONTENT[id]!;
  return {
    id,
    folderId: null,
    title: `Beleg ${id.slice(-1)}`,
    mimeType: 'application/pdf',
    versions: [
      {
        storageBucket: 'gobd',
        storageKey: `key-${id}`,
        storageVersionId: `version-${id}`,
        sizeBytes: BigInt(bytes.length),
        sha256: createHash('sha256').update(bytes).digest(),
        scanStatus: 'CLEAN',
        scanCompletedAt: new Date(),
      },
    ],
  };
}

/** S3: je Schlüssel die gespeicherten Bytes; `stored` ersetzt einzelne Objekte. */
function serve(stored: Record<string, Buffer> = {}) {
  h.send.mockImplementation(async (command: GetObjectCommand) => {
    const id = command.input.Key!.slice('key-'.length);
    const bytes = stored[id] ?? CONTENT[id]!;
    return { Body: Readable.from([Buffer.from(bytes)]), ContentLength: bytes.length };
  });
}

/** Gleiche Länge, anderer Inhalt: nur der SHA-256-Vergleich erkennt es. */
function tampered(bytes: Buffer): Buffer {
  const copy = Buffer.from(bytes);
  copy[copy.length - 1] = 0x21;
  return copy;
}

const call = (ids: string[]) =>
  GET(new NextRequest(`https://local.test/api/staff/documents/download?ids=${ids.join(',')}`));

beforeEach(() => {
  vi.clearAllMocks();
  h.audit.mockResolvedValue({});
  serve();
});

describe('Einzeldownload über den geprüften Leseweg (R-05)', () => {
  it('liefert die Bytes der gebundenen Version nach Größen- und SHA-256-Prüfung', async () => {
    h.read.mockResolvedValue([doc(ID_A)]);

    const response = await call([ID_A]);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe(String(CONTENT[ID_A]!.length));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(CONTENT[ID_A]);
    expect((h.send.mock.calls[0]![0] as GetObjectCommand).input).toEqual({
      Bucket: 'gobd',
      Key: `key-${ID_A}`,
      VersionId: `version-${ID_A}`,
    });
  });

  it('bricht die Antwort bei abweichenden Bytes gleicher Länge ab', async () => {
    h.read.mockResolvedValue([doc(ID_A)]);
    serve({ [ID_A]: tampered(CONTENT[ID_A]!) });

    const response = await call([ID_A]);

    await expect(response.arrayBuffer()).rejects.toMatchObject({
      name: 'StoredObjectError',
      reason: 'HASH_MISMATCH',
    });
  });
});

describe('ZIP-Sammeldownload über den geprüften Leseweg (R-05)', () => {
  it('packt die geprüften Bytes aller ausgewählten Dokumente', async () => {
    h.read.mockResolvedValue([doc(ID_A), doc(ID_B)]);

    const response = await call([ID_A, ID_B]);

    expect(response.status).toBe(200);
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
    expect(Buffer.from(files['Beleg a.pdf']!)).toEqual(CONTENT[ID_A]);
    expect(Buffer.from(files['Beleg b.pdf']!)).toEqual(CONTENT[ID_B]);
  });

  it('bricht das Archiv ab, statt abweichende Bytes eines Dokuments auszuliefern', async () => {
    h.read.mockResolvedValue([doc(ID_A), doc(ID_B)]);
    serve({ [ID_B]: tampered(CONTENT[ID_B]!) });

    const response = await call([ID_A, ID_B]);

    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toMatchObject({
      name: 'StoredObjectError',
      reason: 'HASH_MISMATCH',
    });
  });
});
