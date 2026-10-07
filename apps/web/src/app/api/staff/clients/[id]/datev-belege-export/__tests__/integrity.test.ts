// Fachkatalog: DOC-VERSION-IMMUTABILITY-001, DOC-UPLOAD-JOURNAL-001
// =============================================================================
// R-05: Der DATEV-Belegexport liest jeden Beleg über den gemeinsamen, prüfenden
// Leseweg (streamVerifiedObject). S3 ist am Storage-Client gemockt; Größen- und
// SHA-256-Prüfung laufen echt. Ein Beleg mit abweichenden Bytes wird wie ein
// fehlendes Objekt behandelt: nicht im Archiv, in index.csv als FEHLT ohne Hash.
// =============================================================================

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { GetObjectCommand } from '@aws-sdk/client-s3';
import { unzipSync } from 'fflate';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  findMany: vi.fn(),
  record: vi.fn(),
  send: vi.fn(),
}));

vi.mock('@/server/auth/staff', () => ({
  staffAuth: async () => ({
    user: { tenantId: 'tenant-1', staffId: 'staff-1', fullName: 'Synthetischer Test' },
  }),
}));
vi.mock('@/server/auth/rbac', () => ({ canAccessClientTx: async () => true }));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: async (_ctx: unknown, run: (tx: unknown) => unknown) =>
    run({
      client: {
        findFirst: async () => ({ id: CLIENT_ID, name: 'Testmandant', datevNo: '12345' }),
      },
      document: { findMany: h.findMany },
    }),
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.record } }));
vi.mock('@/server/rate-limit', () => ({
  getClientIp: () => '127.0.0.1',
  checkStaffExportLimit: async () => ({ ok: true }),
}));
vi.mock('@taxtronik/storage/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@taxtronik/storage/client')>()),
  s3: { send: h.send },
}));

import { GET } from '../route';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const CONTENT = [Buffer.from('%PDF-1.7 Beleg eins'), Buffer.from('%PDF-1.7 Beleg zwei')];
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest();

const beleg = (index: number) => ({
  id: `document-${index + 1}`,
  title: `Beleg ${index + 1}`,
  mimeType: 'application/pdf',
  classification: 'GOBD_INVOICE',
  createdAt: new Date('2026-09-07T09:00:00Z'),
  invoiceAttachments: [],
  versions: [
    {
      storageBucket: 'gobd',
      storageKey: `beleg-${index}`,
      storageVersionId: `version-${index}`,
      sizeBytes: BigInt(CONTENT[index]!.length),
      sha256: sha256(CONTENT[index]!),
      scanStatus: 'CLEAN',
      scanCompletedAt: new Date(),
    },
  ],
});

/** S3: je Schlüssel die gespeicherten Bytes; `stored` ersetzt einzelne Objekte. */
function serve(stored: Record<number, Buffer> = {}) {
  h.send.mockImplementation(async (command: GetObjectCommand) => {
    const index = Number(command.input.Key!.slice('beleg-'.length));
    const bytes = stored[index] ?? CONTENT[index]!;
    return { Body: Readable.from([Buffer.from(bytes)]), ContentLength: bytes.length };
  });
}

const call = () =>
  GET(new NextRequest(`https://local.test/api/staff/clients/${CLIENT_ID}/datev-belege-export`), {
    params: Promise.resolve({ id: CLIENT_ID }),
  });

async function exported() {
  const response = await call();
  expect(response.status).toBe(200);
  const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
  const index = Buffer.from(files['index.csv']!).toString('utf8').split('\r\n');
  return { files, index };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.record.mockResolvedValue({});
  h.findMany.mockResolvedValue([beleg(0), beleg(1)]);
  serve();
});

describe('DATEV-Belegexport über den geprüften Leseweg (R-05)', () => {
  it('exportiert die geprüften Bytes der gebundenen Versionen samt Hash im Index', async () => {
    const { files, index } = await exported();

    expect(Buffer.from(files['belege/0001_Beleg 1.pdf']!)).toEqual(CONTENT[0]);
    expect(Buffer.from(files['belege/0002_Beleg 2.pdf']!)).toEqual(CONTENT[1]);
    expect(index[2]).toContain(`belege/0002_Beleg 2.pdf;${sha256(CONTENT[1]!).toString('hex')}`);
    expect((h.send.mock.calls[1]![0] as GetObjectCommand).input).toEqual({
      Bucket: 'gobd',
      Key: 'beleg-1',
      VersionId: 'version-1',
    });
  });

  it('führt einen Beleg mit abweichenden Bytes als FEHLT, ohne Bytes und ohne Hash', async () => {
    const tampered = Buffer.from(CONTENT[1]!);
    tampered[tampered.length - 1] = 0x21;
    serve({ 1: tampered });

    const { files, index } = await exported();

    expect(Object.keys(files)).toEqual(['belege/0001_Beleg 1.pdf', 'index.csv', 'manifest.txt']);
    expect(index[2]).toMatch(/^0002;.*;FEHLT;$/);
    expect(index.join('\n')).not.toContain(sha256(CONTENT[1]!).toString('hex'));
    expect(Buffer.from(files['manifest.txt']!).toString()).toContain(
      'Anzahl Belege: 1 (von 2 insgesamt)',
    );
  });

  it('führt einen Beleg mit abweichender angekündigter Länge als FEHLT', async () => {
    h.send.mockImplementation(async (command: GetObjectCommand) => {
      const index = Number(command.input.Key!.slice('beleg-'.length));
      const bytes = CONTENT[index]!;
      return {
        Body: Readable.from([Buffer.from(bytes)]),
        ContentLength: index === 0 ? bytes.length + 1 : bytes.length,
      };
    });

    const { files, index } = await exported();

    expect(Object.keys(files)).toEqual(['belege/0002_Beleg 2.pdf', 'index.csv', 'manifest.txt']);
    expect(index[1]).toMatch(/^0001;.*;FEHLT;$/);
  });
});
