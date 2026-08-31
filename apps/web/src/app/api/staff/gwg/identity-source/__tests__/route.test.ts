import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  access: vi.fn(),
  check: vi.fn(),
  source: vi.fn(),
  bytes: vi.fn(),
  record: vi.fn(),
  limit: vi.fn(),
  tenantContext: vi.fn(),
}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: mocks.auth }));
vi.mock('@/server/auth/rbac', () => ({ canAccessClientTx: mocks.access }));
vi.mock('@/server/container', () => ({ evidenceService: { record: mocks.record } }));
vi.mock('@/server/gwg/identity-source', () => ({
  loadIdentitySourceTx: mocks.source,
  readIdentitySourceBytes: mocks.bytes,
}));
vi.mock('@/server/rate-limit', () => ({ checkRateLimit: mocks.limit }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: mocks.tenantContext }));
import { GET } from '../route';
const clientId = '11111111-1111-4111-8111-111111111111';
const checkId = '22222222-2222-4222-8222-222222222222';
const documentId = '33333333-3333-4333-8333-333333333333';
const tx = { gwgCheck: { findFirst: mocks.check } };
const request = () =>
  new NextRequest(
    `http://localhost/api/staff/gwg/identity-source?clientId=${clientId}&checkId=${checkId}&documentId=${documentId}`,
  );
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({
    user: { tenantId: 'current-tenant', staffId: 'current-staff', roles: ['EMPLOYEE'] },
  });
  mocks.tenantContext.mockImplementation(async (_ctx: unknown, fn: (value: typeof tx) => unknown) =>
    fn(tx),
  );
  mocks.access.mockResolvedValue(true);
  mocks.check.mockResolvedValue({ id: checkId });
  mocks.source.mockResolvedValue({
    documentId,
    mimeType: 'image/png',
    version: { id: 'version-id' },
  });
  mocks.bytes.mockResolvedValue(Buffer.from('clean-original'));
  mocks.limit.mockResolvedValue({ ok: true });
});
describe('GWG-IDENTIFICATION-EVIDENCE-001 / GWG-SELF-ONBOARDING-001: protected staff source', () => {
  it('rejects unauthenticated access before querying client data', async () => {
    mocks.auth.mockResolvedValueOnce(null);
    expect((await GET(request())).status).toBe(401);
    expect(mocks.tenantContext).not.toHaveBeenCalled();
  });
  it('rejects denied client access without reading checks, documents or storage', async () => {
    mocks.access.mockResolvedValueOnce(false);
    expect((await GET(request())).status).toBe(404);
    expect(mocks.check).not.toHaveBeenCalled();
    expect(mocks.source).not.toHaveBeenCalled();
    expect(mocks.bytes).not.toHaveBeenCalled();
  });
  it('rejects a foreign/missing check and scopes the lookup to the requested client', async () => {
    mocks.check.mockResolvedValueOnce(null);
    expect((await GET(request())).status).toBe(404);
    expect(mocks.check).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: checkId, clientId, destroyedAt: null }),
      }),
    );
    expect(mocks.source).not.toHaveBeenCalled();
  });
  it('binds tenant identity to the session and fails closed for unavailable or unclean evidence', async () => {
    mocks.source.mockResolvedValueOnce(null);
    expect((await GET(request())).status).toBe(404);
    expect(mocks.tenantContext).toHaveBeenCalledWith(
      { tenantId: 'current-tenant', actorId: 'current-staff', actorType: 'STAFF' },
      expect.any(Function),
    );
    expect(mocks.source).toHaveBeenCalledWith(tx, {
      tenantId: 'current-tenant',
      clientId,
      checkId,
      documentId,
    });
    expect(mocks.bytes).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it('never responds with stale/hash-mismatching source bytes', async () => {
    mocks.bytes.mockRejectedValueOnce(new Error('Original hash mismatch'));
    const response = await GET(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'source_unavailable' });
  });
  it('returns approved bytes with no-store and browser containment headers', async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('clean-original');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Content-Security-Policy')).toContain('sandbox');
    expect(response.headers.get('X-Identity-Version')).toBe('version-id');
    expect(mocks.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'gwg.identity.source.view',
        after: { clientId, versionId: 'version-id' },
      }),
    );
  });
  it('limits repeated source requests before storage and rejects malformed IDs', async () => {
    mocks.limit.mockResolvedValueOnce({ ok: false });
    expect((await GET(request())).status).toBe(429);
    expect(mocks.bytes).not.toHaveBeenCalled();
    expect(
      (await GET(new NextRequest('http://localhost/api/staff/gwg/identity-source?clientId=bad')))
        .status,
    ).toBe(404);
  });
});
