// Fachkatalog: FORM-SCHEMA-SNAPSHOT-001, DOC-VERSION-IMMUTABILITY-001, DOC-PORTAL-SHARING-001.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
const h = vi.hoisted(() => ({
  context: vi.fn(),
  guard: vi.fn(),
  source: vi.fn(),
  send: vi.fn(),
  rate: vi.fn(),
  evidence: vi.fn(),
  access: vi.fn(),
}));
vi.mock('@taxtronik/db', () => ({ withTenantContext: h.context }));
vi.mock('@taxtronik/storage', () => ({
  s3: { send: h.send },
  MAX_UPLOAD_BYTES: 16,
  sanitizeFilenameForHeader: (value: string) => value,
}));
vi.mock('@/server/actions/staff-action', () => ({ staffActionGuard: h.guard }));
vi.mock('@/server/actions/portal-action', () => ({ portalActionGuard: h.guard }));
vi.mock('@/server/auth/rbac', () => ({ assertClientAccessTx: h.access }));
vi.mock('@/server/rate-limit', () => ({ checkRateLimit: h.rate }));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.evidence } }));
import { formRevisionDownload } from '../revision-download';
const id = '11111111-1111-4111-8111-111111111111';
const bytes = Buffer.from('original');
const hash = createHash('sha256').update(bytes).digest();
const source = () => ({
  id,
  revisionId: 'revision',
  fieldKey: 'file',
  sha256: hash.toString('hex'),
  revision: { submission: { clientId: 'client' }, answers: { file: { fileName: 'old.pdf' } } },
  documentVersion: {
    id: 'old-version',
    storageBucket: 'bucket',
    storageKey: 'old-key',
    storageVersionId: 'old-storage-version',
    sha256: hash,
    sizeBytes: BigInt(bytes.length),
    scanStatus: 'CLEAN',
    document: {
      id: 'document',
      clientId: 'client',
      deletedAt: null,
      sharedWithClientAt: new Date(),
      title: 'new.png',
      mimeType: 'image/png',
    },
  },
});
const guard = {
  ok: true,
  clientId: 'client',
  tenantId: 'tenant',
  ctx: { tenantId: 'tenant', actorType: 'CLIENT_CONTACT', actorId: 'contact' },
};
function body(value: Buffer) {
  return {
    Body: (async function* () {
      yield value;
    })(),
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  h.context.mockImplementation((_ctx, run) =>
    run({ formSubmissionRevisionFile: { findUnique: h.source } }),
  );
  h.guard.mockResolvedValue(guard);
  h.source.mockImplementation(async () => source());
  h.send.mockImplementation(async () => body(bytes));
  h.rate.mockResolvedValue({ ok: true });
});
describe('FORM-SCHEMA-SNAPSHOT-001 historical file delivery', () => {
  it('delivers the exact old storage version with frozen filename and checks authorization twice', async () => {
    const result = await formRevisionDownload('portal', id);
    expect(result.status).toBe(200);
    expect(Buffer.from(await result.arrayBuffer())).toEqual(bytes);
    expect(h.send.mock.calls[0]![0].input).toEqual({
      Bucket: 'bucket',
      Key: 'old-key',
      VersionId: 'old-storage-version',
    });
    expect(result.headers.get('content-disposition')).toBe('attachment; filename="old.pdf"');
    expect(result.headers.get('content-type')).toBe('application/octet-stream');
    expect(result.headers.get('cache-control')).toBe('private, no-store');
    expect(h.guard).toHaveBeenCalledTimes(2);
    expect(h.evidence).toHaveBeenCalledOnce();
  });
  it('withholds bytes if access is revoked while storage is read', async () => {
    h.guard.mockResolvedValueOnce(guard).mockResolvedValueOnce({ ok: false });
    const result = await formRevisionDownload('portal', id);
    expect(result.status).toBe(404);
    expect(await result.text()).toBe('');
    expect(h.evidence).not.toHaveBeenCalled();
  });
  it.each(['wrong hash', 'wrong size', 'oversized stream'])(
    'rejects %s without recording a completed download',
    async (kind) => {
      if (kind === 'wrong size')
        h.source.mockResolvedValue({
          ...source(),
          documentVersion: { ...source().documentVersion, sizeBytes: 3n },
        });
      else
        h.send.mockImplementation(async () =>
          body(kind === 'wrong hash' ? Buffer.from('modified') : Buffer.alloc(17)),
        );
      expect((await formRevisionDownload('portal', id)).status).toBe(404);
      expect(h.evidence).not.toHaveBeenCalled();
    },
  );
  it.each(['unshared', 'deleted', 'quarantined'])(
    'does not fetch an %s historical source',
    async (kind) => {
      const row = source();
      if (kind === 'quarantined') row.documentVersion.scanStatus = 'INFECTED';
      h.source.mockResolvedValue({
        ...row,
        documentVersion: {
          ...row.documentVersion,
          document: {
            ...row.documentVersion.document,
            ...(kind === 'unshared' ? { sharedWithClientAt: null } : {}),
            ...(kind === 'deleted' ? { deletedAt: new Date() } : {}),
          },
        },
      });
      expect((await formRevisionDownload('portal', id)).status).toBe(404);
      expect(h.send).not.toHaveBeenCalled();
    },
  );
});
