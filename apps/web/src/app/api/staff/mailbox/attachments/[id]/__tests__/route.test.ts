// Fachkatalog: MAIL-INBOX-001
// =============================================================================
// R-05: Der Anhangabruf des Smart-Postfachs liest über den gemeinsamen,
// prüfenden Leseweg (fetchVerifiedObjectBytes) und prüft Größe und SHA-256 des
// geprüften Anhangs vor Audit und Auslieferung. S3 ist am Storage-Client
// gemockt; Prüfung und Antwortkörper laufen echt. Header, Statuscodes und
// Zugriffsprüfungen bleiben unverändert.
// =============================================================================

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { GetObjectCommand } from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  staffAuth: vi.fn(),
  guard: vi.fn(),
  withTenantContext: vi.fn(),
  modules: vi.fn(),
  attachment: vi.fn(),
  record: vi.fn(),
  send: vi.fn(),
}));

vi.mock('@/server/auth/staff', () => ({ staffAuth: h.staffAuth }));
vi.mock('@/server/actions/staff-action', () => ({ staffActionGuard: h.guard }));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.record } }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: h.withTenantContext }));
vi.mock('@taxtronik/db/tenant-modules', () => ({ readBooleanTenantModules: h.modules }));
vi.mock('@taxtronik/storage/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@taxtronik/storage/client')>()),
  s3: { send: h.send },
}));

import { getBucketForTier } from '@taxtronik/storage';
import { GET } from '../route';

const ATTACHMENT_ID = '11111111-1111-4111-8111-111111111111';
const BYTES = Buffer.from('Rechnung als PDF-Anhang');
const ATTACHMENT = {
  id: ATTACHMENT_ID,
  filename: "Rechnung Mai'26.pdf",
  mimeType: 'application/pdf',
  sha256: createHash('sha256').update(BYTES).digest('hex'),
  sizeBytes: BYTES.length,
  storageKey: `tenant-1/inbound-staging/${ATTACHMENT_ID}/hash`,
  status: 'CLEAN',
};

function stored(bytes: Buffer, contentLength: number | null = bytes.length) {
  h.send.mockResolvedValueOnce({
    Body: Readable.from([bytes]),
    ContentLength: contentLength ?? undefined,
  });
}

function call() {
  return GET(new Request(`http://localhost/api/staff/mailbox/attachments/${ATTACHMENT_ID}`), {
    params: Promise.resolve({ id: ATTACHMENT_ID }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.staffAuth.mockResolvedValue({ user: { tenantId: 'tenant-1', staffId: 'staff-1' } });
  h.guard.mockResolvedValue({
    ok: true,
    tenantId: 'tenant-1',
    staffId: 'staff-1',
    ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
  });
  h.attachment.mockResolvedValue(ATTACHMENT);
  h.modules.mockResolvedValue({ smartMailbox: true });
  h.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({ inboundAttachment: { findFirst: h.attachment } }),
  );
  h.record.mockResolvedValue({});
});

describe('Smart-Postfach-Anhang: geprüfter Abruf (R-05)', () => {
  it('liefert den geprüften Anhang mit unveränderten Headern und einem Abrufnachweis', async () => {
    stored(BYTES);

    const response = await call();

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(BYTES);
    expect((h.send.mock.calls[0]![0] as GetObjectCommand).input).toEqual({
      Bucket: getBucketForTier('NONE'),
      Key: ATTACHMENT.storageKey,
    });
    expect(Object.fromEntries(response.headers)).toEqual({
      'content-type': 'application/pdf',
      'content-disposition':
        'attachment; filename="attachment"; filename*=UTF-8\'\'Rechnung%20Mai%2726.pdf',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    });
    expect(h.record).toHaveBeenCalledOnce();
    expect(h.record.mock.calls[0]![1]).toMatchObject({
      action: 'mailbox.attachment_download',
      after: { sha256: ATTACHMENT.sha256 },
    });
  });

  it.each([
    ['abweichende Bytes gleicher Länge', () => stored(Buffer.from('Rechnung als PDF-ANHANG'))],
    ['eine abweichend angekündigte Länge', () => stored(BYTES, BYTES.length - 1)],
    ['zusätzliche Bytes ohne Längenangabe', () => stored(Buffer.concat([BYTES, BYTES]), null)],
  ])('weist %s ohne Abrufnachweis mit 409 ab', async (_case, arrange) => {
    arrange();

    const response = await call();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'Anhang nicht sicher verfügbar.' });
    expect(h.record).not.toHaveBeenCalled();
  });

  it('liest einen nicht geprüften Anhang nicht aus dem Speicher (404 wie bisher)', async () => {
    h.attachment.mockResolvedValue(null);

    const response = await call();

    expect(response.status).toBe(404);
    expect(h.send).not.toHaveBeenCalled();
  });
});
