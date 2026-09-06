// Fachkatalog: WORKFLOW-LIFECYCLE-001, CLIENT-FEEDBACK-001.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  status: 'ACTIVE',
  query: vi.fn(),
  itemUpdate: vi.fn(),
  parentRead: vi.fn(),
  parentUpdate: vi.fn(),
  parentAfter: vi.fn(),
  record: vi.fn(),
  access: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: vi.fn() }));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.record } }));
vi.mock('@/server/workflows/execute-step', () => ({ executeWorkflowStep: vi.fn() }));
vi.mock('@/server/db/assert-tenant', () => ({
  assertClientInTenant: vi.fn(),
  assertStaffInTenant: vi.fn(),
}));
vi.mock('@/server/auth/rbac', () => ({
  assertClientAccessTx: h.access,
  filterStaffAccessClientTx: vi.fn(),
  toActionError: vi.fn(),
}));
vi.mock('@/server/actions/staff-action', () => ({
  ActionError: class extends Error {},
  staffActionGuard: vi.fn(),
  withStaffModule: () => async (fn: (tx: unknown, ctx: unknown) => Promise<object>) => {
    try {
      return {
        ok: true,
        ...(await fn(
          {
            $queryRaw: h.query,
            workflowItem: {
              findUnique: async () => ({ instance: { clientId: 'client', status: h.status } }),
              update: h.itemUpdate,
            },
            workflowInstance: {
              findUnique: h.parentRead,
              updateMany: h.parentUpdate,
              findUniqueOrThrow: h.parentAfter,
            },
          },
          { staffId: 'staff', session: { user: {} } },
        )),
      };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  },
}));
import { toggleItemDoneAction, resumeInstanceAction, restoreInstanceAction } from '../actions';
const ITEM = '11111111-1111-4111-8111-111111111111';
describe('WORKFLOW-LIFECYCLE-001 manual status gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.status = 'ACTIVE';
    h.itemUpdate.mockResolvedValue({ instanceId: 'instance' });
    h.parentRead.mockResolvedValue({ status: 'ACTIVE', feedbackContactId: null });
  });
  it.each(['CANCELLED', 'PAUSED'])(
    'rejects %s from an old browser without changing an item',
    async (status) => {
      h.status = status;
      expect(await toggleItemDoneAction({ id: ITEM, done: true })).toMatchObject({ ok: false });
      expect(h.itemUpdate).not.toHaveBeenCalled();
      expect(h.query).toHaveBeenCalledTimes(2);
    },
  );
  it('leaves reconciliation to the database and allows explicit reopening', async () => {
    h.status = 'COMPLETED';
    expect(await toggleItemDoneAction({ id: ITEM, done: false })).toMatchObject({ ok: true });
    expect(h.itemUpdate).toHaveBeenCalledWith({
      where: { id: ITEM },
      data: { doneAt: null, doneByStaff: null },
    });
  });
  it.each([
    ['PAUSED', resumeInstanceAction, 'workflow.instance.resume'],
    ['CANCELLED', restoreInstanceAction, 'workflow.instance.restore'],
  ] as const)(
    'records the actual reconciled state after %s is resumed',
    async (status, action, auditAction) => {
      h.parentRead.mockResolvedValue({ id: ITEM, clientId: 'client', status, notes: null });
      h.parentUpdate.mockResolvedValue({ count: 1 });
      const after = { status: 'COMPLETED', completedAt: new Date('2026-09-06T12:00:00Z') };
      h.parentAfter.mockResolvedValue(after);
      expect(await action({ instanceId: ITEM })).toMatchObject({ ok: true });
      expect(h.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: auditAction, after }),
      );
    },
  );
});
