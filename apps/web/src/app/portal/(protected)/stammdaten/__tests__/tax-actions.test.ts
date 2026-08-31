import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  guard: vi.fn(),
  context: vi.fn(),
  feature: vi.fn(),
  load: vi.fn(),
  record: vi.fn(),
  notify: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.context }));
vi.mock('@/server/actions/portal-action', () => ({
  portalActionGuard: m.guard,
  ActionError: class extends Error {},
}));
vi.mock('@/server/auth/rbac', () => ({
  toActionError: (error: Error) => ({ ok: false, error: error.message }),
}));
vi.mock('@/server/settings/portal-features', () => ({ assertPortalFeature: m.feature }));
vi.mock('@/server/tax-master-data/service', () => ({ loadTaxMasterDataTx: m.load }));
vi.mock('@/server/container', () => ({ evidenceService: { record: m.record } }));
vi.mock('@/server/notifications/service', () => ({ notify: m.notify }));
import { submitTaxChangeAction } from '../tax-actions';

const clientId = '11111111-1111-4111-8111-111111111111';
const revision = 'a'.repeat(64);
const draft = {
  vatId: 'DE123456789',
  registrations: [
    {
      label: 'Umsatzsteuer',
      stateCode: 'BE',
      number: '12/345/67890',
      taxOfficeName: 'Berlin',
      isPrimary: true,
    },
  ],
};
function db() {
  return {
    $queryRaw: vi.fn(),
    clientMasterChangeRequest: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'request' }),
    },
    clientResponsibility: { findMany: vi.fn().mockResolvedValue([]) },
    client: { update: vi.fn() },
    clientTaxRegistration: { update: vi.fn() },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  m.guard.mockResolvedValue({
    ok: true,
    clientId,
    tenantId: 'tenant',
    contactId: 'contact',
    ctx: {},
  });
  m.feature.mockResolvedValue(undefined);
  m.load.mockResolvedValue({
    draft: { vatId: '', registrations: [] },
    revision,
    anonymized: false,
  });
});
describe('TAX-MASTER-DATA-001 portal proposals', () => {
  it('ACCESS-CLIENT-MODE-001 denies another client before reading or writing', async () => {
    expect(
      await submitTaxChangeAction({
        clientId: '22222222-2222-4222-8222-222222222222',
        expectedRevision: revision,
        draft,
      }),
    ).toEqual({ ok: false, error: 'Kein Zugriff.' });
    expect(m.context).not.toHaveBeenCalled();
  });
  it('stores a versioned request only, never canonical tax data', async () => {
    const tx = db();
    m.context.mockImplementation(async (_ctx, fn) => fn(tx));
    expect(await submitTaxChangeAction({ clientId, expectedRevision: revision, draft })).toEqual({
      ok: true,
    });
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.clientMasterChangeRequest.findFirst.mock.invocationCallOrder[0]!,
    );
    expect(tx.clientMasterChangeRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fields: { taxData: { version: 1, expectedRevision: revision, draft } },
        }),
      }),
    );
    expect(tx.client.update).not.toHaveBeenCalled();
    expect(tx.clientTaxRegistration.update).not.toHaveBeenCalled();
    expect(m.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ actorType: 'CLIENT_CONTACT' }),
    );
  });
  it('rejects stale page snapshots and foreign registration IDs', async () => {
    const tx = db();
    m.context.mockImplementation(async (_ctx, fn) => fn(tx));
    const stale = await submitTaxChangeAction({
      clientId,
      expectedRevision: 'b'.repeat(64),
      draft,
    });
    expect(stale.ok).toBe(false);
    const forged = await submitTaxChangeAction({
      clientId,
      expectedRevision: revision,
      draft: { ...draft, registrations: [{ ...draft.registrations[0]!, id: clientId }] },
    });
    expect(forged.ok).toBe(false);
    expect(tx.clientMasterChangeRequest.create).not.toHaveBeenCalled();
  });
  it('honors the portal feature flag and an existing pending request', async () => {
    m.feature.mockRejectedValueOnce(new Error('Deaktiviert'));
    expect((await submitTaxChangeAction({ clientId, expectedRevision: revision, draft })).ok).toBe(
      false,
    );
    expect(m.context).not.toHaveBeenCalled();
    const tx = db();
    tx.clientMasterChangeRequest.findFirst.mockResolvedValue({ id: 'old' });
    m.context.mockImplementation(async (_ctx, fn) => fn(tx));
    expect((await submitTaxChangeAction({ clientId, expectedRevision: revision, draft })).ok).toBe(
      false,
    );
    expect(tx.clientMasterChangeRequest.create).not.toHaveBeenCalled();
  });
});
