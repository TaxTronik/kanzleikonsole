import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';

const mocks = vi.hoisted(() => ({
  lock: vi.fn(),
  fresh: vi.fn(),
  copy: vi.fn(),
  cancel: vi.fn(),
  record: vi.fn(),
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: mocks.record } }));
vi.mock('@/server/auth/rbac', () => ({ ActionError: class ActionError extends Error {} }));
vi.mock('@/server/gwg/reverification', () => ({
  lockGwgCheckLifecycleTx: mocks.lock,
  startFreshGwgReviewTx: mocks.fresh,
  copyGwgSnapshotTx: mocks.copy,
  GWG_SNAPSHOT_COPY_INCLUDE: { beneficialOwners: true },
}));
vi.mock('../invite-lifecycle', () => ({ cancelOpenGwgInvitesTx: mocks.cancel }));
import { startManualGwgCaptureTx } from '../manual-capture';

const input = { tenantId: 'tenant', clientId: 'client', staffId: 'staff' };
function transaction(status: string | null) {
  const latest = status
    ? { id: 'existing', status, destroyedAt: null, riskAnswers: { complete: true } }
    : null;
  return {
    client: { findFirst: vi.fn().mockResolvedValue({ id: 'client' }) },
    gwgCheck: { findFirst: vi.fn().mockResolvedValue(latest) },
    gwgOnboardingInvite: { findMany: vi.fn().mockResolvedValue([{ id: 'open-invite' }]) },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.cancel.mockResolvedValue(1);
  mocks.copy.mockResolvedValue({
    copiedOwnerCount: 2,
    copiedDocumentCount: 1,
    copiedLinkedDocumentCount: 1,
  });
  mocks.fresh.mockResolvedValue({ reviewCheckId: 'new', clientDeactivated: true });
});

describe('GWG-SELF-ONBOARDING-001 / GWG-ACTIVATION-GATE-001: staff capture alternative', () => {
  it.each(['DRAFT', 'IN_REVIEW'])(
    'reuses %s without replacing people, risk answers or handover',
    async (status) => {
      const tx = transaction(status);
      const result = await startManualGwgCaptureTx(tx as unknown as TxClient, input);
      expect(result).toEqual({ checkId: 'existing', reused: true, cancelledInviteCount: 1 });
      expect(mocks.fresh).not.toHaveBeenCalled();
      expect(mocks.copy).not.toHaveBeenCalled();
      expect(mocks.cancel).toHaveBeenCalledWith(tx, {
        tenantId: 'tenant',
        clientId: 'client',
        cancelledByStaff: 'staff',
        cancellationReason: 'Erfassung durch Kanzlei',
      });
      expect(tx.gwgOnboardingInvite.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: 'tenant', clientId: 'client', status: { in: ['PENDING', 'STARTED'] } },
        }),
      );
      expect(mocks.record).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          action: 'gwg.onboarding.manual.start',
          before: { openInviteIds: ['open-invite'] },
          after: expect.objectContaining({ reused: true, cancelledInviteCount: 1 }),
        }),
      );
    },
  );
  it('serializes before inspecting state and creates at most one initial draft on repeated entry', async () => {
    const tx = transaction(null);
    mocks.fresh.mockImplementationOnce(async () => {
      tx.gwgCheck.findFirst.mockResolvedValue({
        id: 'new',
        status: 'DRAFT',
        destroyedAt: null,
        riskAnswers: { complete: true },
      });
      return { reviewCheckId: 'new', clientDeactivated: true };
    });
    expect((await startManualGwgCaptureTx(tx as unknown as TxClient, input)).checkId).toBe('new');
    expect((await startManualGwgCaptureTx(tx as unknown as TxClient, input)).checkId).toBe('new');
    expect(mocks.fresh).toHaveBeenCalledTimes(1);
    expect(mocks.lock.mock.invocationCallOrder[0]).toBeLessThan(
      tx.gwgCheck.findFirst.mock.invocationCallOrder[0]!,
    );
  });
  it.each(['VERIFIED', 'REJECTED', 'EXPIRED'])(
    'uses the existing fresh-review/copy path for terminal %s',
    async (status) => {
      const tx = transaction(status);
      const result = await startManualGwgCaptureTx(tx as unknown as TxClient, input);
      expect(result.reused).toBe(false);
      expect(mocks.fresh).toHaveBeenCalledWith(tx, {
        tenantId: 'tenant',
        clientId: 'client',
        predecessorCheckId: 'existing',
        changeScope: 'ROUTINE',
      });
      expect(mocks.copy).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          targetCheckId: 'new',
          source: expect.objectContaining({ id: 'existing', status }),
        }),
      );
    },
  );
  it('does not mutate if the client is absent in the tenant scope', async () => {
    const tx = transaction(null);
    tx.client.findFirst.mockResolvedValueOnce(null);
    await expect(startManualGwgCaptureTx(tx as unknown as TxClient, input)).rejects.toThrow(
      'Mandant nicht gefunden',
    );
    expect(mocks.fresh).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });
});
