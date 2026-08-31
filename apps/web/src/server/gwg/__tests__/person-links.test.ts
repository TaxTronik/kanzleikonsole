import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ access: vi.fn(), audit: vi.fn(), lock: vi.fn() }));
vi.mock('@/server/auth/rbac', () => ({
  assertClientAccessTx: mocks.access,
  accessibleClientsWhereFor: vi.fn().mockResolvedValue({}),
  ActionError: class extends Error {},
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: mocks.audit } }));
vi.mock('../reverification', () => ({ lockGwgCheckLifecycleTx: mocks.lock }));
import { changeGwgPersonLinkTx } from '../person-links';
const session = { user: { tenantId: 'tenant', staffId: 'staff' } } as never;
function database() {
  return {
    gwgPersonAnchor: {
      findMany: vi.fn().mockResolvedValue([
        { id: 'a', clientId: 'client-a', naturalClientId: null },
        { id: 'b', clientId: 'client-b', naturalClientId: null },
      ]),
    },
    gwgCheck: {
      findFirst: vi.fn().mockResolvedValue({
        client: { anonymizedAt: null, kind: 'JURPERS' },
        beneficialOwners: [{ id: 'owner' }],
        representatives: [],
      }),
    },
    gwgPersonLink: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'link' }),
      delete: vi.fn(),
    },
  };
}
describe('GWG-PERSON-LINKS-001 link authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.access.mockResolvedValue(undefined);
  });
  it('checks both mandates before creating one canonical edge and auditing', async () => {
    const tx = database();
    await changeGwgPersonLinkTx(tx as never, session, { left: 'b', right: 'a', remove: false });
    expect(mocks.access.mock.calls.map((call) => call[2])).toEqual(['client-a', 'client-b']);
    expect(tx.gwgPersonLink.create).toHaveBeenCalledWith({
      data: { tenantId: 'tenant', fromAnchorId: 'a', toAnchorId: 'b', createdBy: 'staff' },
    });
    expect(mocks.audit).toHaveBeenCalledTimes(1);
  });
  it('cannot mutate a link when either mandate is hidden', async () => {
    const tx = database();
    mocks.access.mockImplementation(async (_tx, _session, id) => {
      if (id === 'client-b') throw new Error('denied');
    });
    await expect(
      changeGwgPersonLinkTx(tx as never, session, { left: 'a', right: 'b', remove: true }),
    ).rejects.toThrow('denied');
    expect(tx.gwgPersonLink.delete).not.toHaveBeenCalled();
    expect(tx.gwgPersonLink.create).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it('rejects stale or purged local anchors', async () => {
    const tx = database();
    tx.gwgCheck.findFirst.mockResolvedValue(null);
    await expect(
      changeGwgPersonLinkTx(tx as never, session, { left: 'a', right: 'b', remove: false }),
    ).rejects.toThrow('geändert');
    expect(tx.gwgPersonLink.create).not.toHaveBeenCalled();
  });
  it('removes only the confirmed pair, never all members of a group', async () => {
    const tx = database();
    tx.gwgPersonLink.findUnique.mockResolvedValue({ id: 'ab' });
    await changeGwgPersonLinkTx(tx as never, session, { left: 'a', right: 'b', remove: true });
    expect(tx.gwgPersonLink.delete).toHaveBeenCalledWith({ where: { id: 'ab' } });
  });
});
