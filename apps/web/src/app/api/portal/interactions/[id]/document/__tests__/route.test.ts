// Fachkatalog: TAX-NOTICE-DECISION-001, DOC-VERSION-IMMUTABILITY-001
// =============================================================================
// R-05: Der Bescheid-Dokumentabruf des Portals liest die gebundene Fassung über
// den gemeinsamen, prüfenden Leseweg (fetchVerifiedObjectBytes) statt über eine
// eigene S3-Leseschleife. S3 ist am Storage-Client gemockt; Größen- und
// Hashprüfung sowie der Antwortkörper laufen echt. Header, Statuscodes und
// Zugriffsprüfungen bleiben unverändert.
// =============================================================================

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { GetObjectCommand } from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  portalAuth: vi.fn(),
  readModules: vi.fn(),
  readLimit: vi.fn(),
  withTenantContext: vi.fn(),
  record: vi.fn(),
  send: vi.fn(),
  interaction: vi.fn(),
  document: vi.fn(),
}));

vi.mock('@/server/auth/portal', () => ({ portalAuth: h.portalAuth }));
vi.mock('@/server/settings/modules', () => ({ readModules: h.readModules }));
vi.mock('@/server/rate-limit', () => ({ checkPortalReadLimit: h.readLimit }));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.record } }));
vi.mock('@/server/workflows/interactions', () => ({
  noticeDecisionSnapshot: { parse: (value: unknown) => value },
}));
vi.mock('@taxtronik/db', () => ({ withTenantContext: h.withTenantContext }));
vi.mock('@taxtronik/storage/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@taxtronik/storage/client')>()),
  s3: { send: h.send },
}));

import { GET } from '../route';

const INTERACTION_ID = '11111111-1111-4111-8111-111111111111';
const BYTES = Buffer.from('%PDF-1.7 Bescheid');
const SHA256 = createHash('sha256').update(BYTES).digest();
const SNAPSHOT = {
  documentId: '22222222-2222-4222-8222-222222222222',
  documentVersionId: '33333333-3333-4333-8333-333333333333',
  documentSha256: SHA256.toString('hex'),
};

function stored(bytes: Buffer, contentLength: number | null = bytes.length) {
  const body = Readable.from([bytes]);
  h.send.mockResolvedValueOnce({ Body: body, ContentLength: contentLength ?? undefined });
  return body;
}

function call() {
  return GET(
    new Request(`http://portal.example.de/api/portal/interactions/${INTERACTION_ID}/document`),
    {
      params: Promise.resolve({ id: INTERACTION_ID }),
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.portalAuth.mockResolvedValue({
    user: { tenantId: 'tenant-1', contactId: 'contact-1', clientId: 'client-1' },
  });
  h.readModules.mockResolvedValue({ noticeDecisions: true, taxNotices: true });
  h.readLimit.mockResolvedValue({ ok: true });
  h.interaction.mockResolvedValue({ id: INTERACTION_ID, snapshot: SNAPSHOT });
  h.document.mockResolvedValue({
    id: SNAPSHOT.documentId,
    title: 'Bescheid-2025.pdf',
    mimeType: 'application/pdf',
    versions: [
      {
        id: SNAPSHOT.documentVersionId,
        storageBucket: 'gobd',
        storageKey: 'tenant-1/bescheid',
        storageVersionId: 'bound-version',
        sha256: new Uint8Array(SHA256),
        sizeBytes: BigInt(BYTES.length),
      },
    ],
  });
  h.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({ clientInteraction: { findFirst: h.interaction }, document: { findFirst: h.document } }),
  );
  h.record.mockResolvedValue({});
});

describe('Portal-Bescheiddokument: gebundene Fassung (R-05)', () => {
  it('liefert die geprüfte Fassung mit unveränderten Headern und einem Abrufnachweis', async () => {
    stored(BYTES);

    const response = await call();

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(BYTES);
    expect((h.send.mock.calls[0]![0] as GetObjectCommand).input).toEqual({
      Bucket: 'gobd',
      Key: 'tenant-1/bescheid',
      VersionId: 'bound-version',
    });
    expect(Object.fromEntries(response.headers)).toEqual({
      'content-type': 'application/pdf',
      'content-disposition': 'attachment; filename="Bescheid-2025.pdf"',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    });
    expect(h.record).toHaveBeenCalledOnce();
    expect(h.record.mock.calls[0]![1]).toMatchObject({
      action: 'notice.decision.document_download',
      after: { documentVersionId: SNAPSHOT.documentVersionId },
    });
  });

  it.each([
    ['abweichende Bytes gleicher Länge', () => stored(Buffer.from('%PDF-1.7 BESCHEID'))],
    ['eine abweichend angekündigte Länge', () => stored(BYTES, BYTES.length + 1)],
    ['zusätzliche Bytes ohne Längenangabe', () => stored(Buffer.concat([BYTES, BYTES]), null)],
  ])('weist %s ohne Abrufnachweis mit 502 ab', async (_case, arrange) => {
    arrange();

    const response = await call();

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: 'document_unavailable' });
    expect(h.record).not.toHaveBeenCalled();
  });

  it('liest ohne passende gebundene Fassung keine Bytes (404 wie bisher)', async () => {
    h.interaction.mockResolvedValue({
      id: INTERACTION_ID,
      snapshot: { ...SNAPSHOT, documentSha256: '00'.repeat(32) },
    });

    const response = await call();

    expect(response.status).toBe(404);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
  });
});
