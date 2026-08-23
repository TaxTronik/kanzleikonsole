import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  class ActionError extends Error {}
  return {
    ActionError,
    withStaff: vi.fn(),
    filterAccess: vi.fn(),
    assertClientAccess: vi.fn(),
    assertClientInTenant: vi.fn(),
    assertStaffInTenant: vi.fn(),
    evidenceRecord: vi.fn(),
    revalidatePath: vi.fn(),
    tx: null as Record<string, unknown> | null,
  };
});

vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: vi.fn() }));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.evidenceRecord } }));
vi.mock('@/server/workflows/execute-step', () => ({ executeWorkflowStep: vi.fn() }));
vi.mock('@/server/db/assert-tenant', () => ({
  assertClientInTenant: h.assertClientInTenant,
  assertStaffInTenant: h.assertStaffInTenant,
}));
vi.mock('@/server/auth/rbac', () => ({
  assertClientAccessTx: h.assertClientAccess,
  filterStaffAccessClientTx: h.filterAccess,
  toActionError: vi.fn(),
}));
vi.mock('@/server/actions/staff-action', () => ({
  ActionError: h.ActionError,
  staffActionGuard: vi.fn(),
  withStaffModule: () => h.withStaff,
}));

import {
  addItemToInstanceAction,
  handoverItemAction,
  setItemAssigneeAction,
  setWorkflowMembersAction,
  startInstanceAction,
} from '../actions';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLIENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACTOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TARGET = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SECOND = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ITEM = '11111111-1111-4111-8111-111111111111';
const INSTANCE = '22222222-2222-4222-8222-222222222222';

function makeTx() {
  return {
    workflowItem: {
      findUnique: vi.fn(async () => ({
        id: ITEM,
        instanceId: INSTANCE,
        assigneeStaffId: ACTOR,
        doneAt: null,
        instance: { clientId: CLIENT },
      })),
      update: vi.fn(async () => ({ id: ITEM })),
      create: vi.fn(async () => ({ id: ITEM })),
    },
    workflowItemComment: { create: vi.fn(async () => ({ id: 'comment-1' })) },
    workflowInstance: {
      findUnique: vi.fn(async () => ({
        id: INSTANCE,
        clientId: CLIENT,
        status: 'ACTIVE',
        startedByStaff: ACTOR,
        members: [{ staffId: ACTOR }],
        items: [{ position: 2 }],
      })),
      create: vi.fn(async () => ({ id: INSTANCE })),
    },
    workflowInstanceMember: {
      createMany: vi.fn(async () => ({ count: 1 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    workflowTemplate: { findUnique: vi.fn(async () => null) },
    riskAnalysis: { findFirst: vi.fn(async () => null) },
    staffUser: {
      findUnique: vi.fn(async () => ({ fullName: 'Ziel Person', active: true })),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const tx = makeTx();
  h.tx = tx;
  h.filterAccess.mockImplementation(
    async (_tx: unknown, _tenant: string, staffIds: readonly string[]) => new Set(staffIds),
  );
  h.withStaff.mockImplementation(
    async (callback: (tx: unknown, ctx: unknown) => Promise<unknown>) => {
      try {
        const value = await callback(tx, {
          tenantId: TENANT,
          staffId: ACTOR,
          session: { user: { name: 'Actor' } },
        });
        return { ok: true, ...(value && typeof value === 'object' ? value : {}) };
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
    },
  );
});

describe('Workflow-Zuweisungen respektieren die Mandanten-Zugriffspolicy', () => {
  it('OPEN + nicht vertraulich erlaubt spontane Zuweisung an aktive Tenant-Mitarbeitende', async () => {
    const tx = h.tx as ReturnType<typeof makeTx>;

    await expect(setItemAssigneeAction({ id: ITEM, staffId: TARGET })).resolves.toMatchObject({
      ok: true,
    });

    expect(h.filterAccess).toHaveBeenCalledWith(tx, TENANT, [TARGET], CLIENT);
    expect(tx.workflowItem.update).toHaveBeenCalledWith({
      where: { id: ITEM },
      data: { assigneeStaffId: TARGET },
    });
  });

  it('RESTRICTED verweigert unzugeordnete Bearbeitende vor der Item-Aenderung', async () => {
    const tx = h.tx as ReturnType<typeof makeTx>;
    h.filterAccess.mockResolvedValueOnce(new Set());

    await expect(setItemAssigneeAction({ id: ITEM, staffId: TARGET })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/nicht zugreifen/),
    });

    expect(tx.workflowItem.update).not.toHaveBeenCalled();
  });

  it('OPEN + vertraulich verweigert eine Uebergabe an Unbefugte samt Kommentar/Audit', async () => {
    const tx = h.tx as ReturnType<typeof makeTx>;
    h.filterAccess.mockResolvedValueOnce(new Set());

    await expect(
      handoverItemAction({ itemId: ITEM, toStaffId: TARGET, note: 'Bitte uebernehmen' }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/nicht zugreifen/) });

    expect(tx.staffUser.findUnique).not.toHaveBeenCalled();
    expect(tx.workflowItem.update).not.toHaveBeenCalled();
    expect(tx.workflowItemComment.create).not.toHaveBeenCalled();
    expect(h.evidenceRecord).not.toHaveBeenCalled();
  });

  it('verweigert beim Ad-hoc-Schritt eine Cross-Tenant-Ziel-ID vor dem Insert', async () => {
    const tx = h.tx as ReturnType<typeof makeTx>;
    h.filterAccess.mockResolvedValueOnce(new Set());

    await expect(
      addItemToInstanceAction({
        instanceId: INSTANCE,
        title: 'Pruefen',
        assigneeStaffId: TARGET,
      }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/nicht zugreifen/) });

    expect(h.filterAccess).toHaveBeenCalledWith(tx, TENANT, [TARGET], CLIENT);
    expect(tx.workflowItem.create).not.toHaveBeenCalled();
  });

  it('validiert initiale Workflow-Mitglieder vor dem Erzeugen der Instanz', async () => {
    const tx = h.tx as ReturnType<typeof makeTx>;
    h.filterAccess.mockResolvedValueOnce(new Set([ACTOR]));

    await expect(
      startInstanceAction({ clientId: CLIENT, name: 'Eigener Workflow', memberIds: [TARGET] }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/nicht zugreifen/) });

    expect(h.filterAccess).toHaveBeenCalledWith(tx, TENANT, [ACTOR, TARGET], CLIENT);
    expect(tx.workflowInstance.create).not.toHaveBeenCalled();
    expect(tx.workflowInstanceMember.createMany).not.toHaveBeenCalled();
  });

  it('validiert neu hinzukommende Mitglieder als Batch und schreibt bei Teilmenge nichts', async () => {
    const tx = h.tx as ReturnType<typeof makeTx>;
    h.filterAccess.mockResolvedValueOnce(new Set([TARGET]));

    await expect(
      setWorkflowMembersAction({ instanceId: INSTANCE, memberIds: [TARGET, SECOND] }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/nicht zugreifen/) });

    expect(h.filterAccess).toHaveBeenCalledWith(tx, TENANT, [TARGET, SECOND], CLIENT);
    expect(tx.workflowInstanceMember.createMany).not.toHaveBeenCalled();
    expect(tx.workflowInstanceMember.deleteMany).not.toHaveBeenCalled();
  });
});
