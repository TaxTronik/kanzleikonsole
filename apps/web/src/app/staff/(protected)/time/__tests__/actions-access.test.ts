import { beforeEach, describe, expect, it, vi } from 'vitest';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const ENTRY_ID = '22222222-2222-4222-8222-222222222222';

const m = vi.hoisted(() => ({
  withStaff: vi.fn(),
  assertClientAccessTx: vi.fn(),
  assertClientInTenant: vi.fn(),
  evidenceRecord: vi.fn(),
}));

vi.mock('@/server/actions/staff-action', async () => {
  const { parseFormData } = await import('@/server/actions/form-data');
  return {
    withStaff: m.withStaff,
    ActionError: class ActionError extends Error {},
    parseFormData,
  };
});
vi.mock('@/server/auth/rbac', () => ({ assertClientAccessTx: m.assertClientAccessTx }));
vi.mock('@/server/db/assert-tenant', () => ({ assertClientInTenant: m.assertClientInTenant }));
vi.mock('@/server/container', () => ({ evidenceService: { record: m.evidenceRecord } }));

import { deleteTimeEntryAction, stopTimerAction } from '../actions';

beforeEach(() => {
  vi.clearAllMocks();
  m.evidenceRecord.mockResolvedValue({});
});

function runWithTx(tx: unknown) {
  m.withStaff.mockImplementation(async (fn: (txArg: unknown, ctx: unknown) => unknown) =>
    fn(tx, {
      tenantId: 'tenant-1',
      staffId: 'staff-1',
      session: { user: { tenantId: 'tenant-1', staffId: 'staff-1' } },
    }),
  );
}

describe('Zeiterfassungs-Actions — RESTRICTED-Gate', () => {
  it('prüft den Zugriff vor dem Stoppen eines mandantenbezogenen Timers', async () => {
    const tx = {
      timeEntry: {
        findFirst: vi.fn().mockResolvedValue({
          id: ENTRY_ID,
          clientId: CLIENT_ID,
          startedAt: new Date('2026-08-01T08:00:00.000Z'),
        }),
        update: vi.fn().mockResolvedValue({
          id: ENTRY_ID,
          clientId: CLIENT_ID,
          startedAt: new Date('2026-08-01T08:00:00.000Z'),
          endedAt: new Date('2026-08-01T09:00:00.000Z'),
        }),
      },
    };
    runWithTx(tx);

    await stopTimerAction();

    expect(m.assertClientAccessTx).toHaveBeenCalledWith(tx, expect.any(Object), CLIENT_ID);
    expect(m.assertClientAccessTx.mock.invocationCallOrder[0]).toBeLessThan(
      tx.timeEntry.update.mock.invocationCallOrder[0]!,
    );
  });

  it('prüft den Zugriff vor dem Löschen eines mandantenbezogenen Eintrags', async () => {
    const tx = {
      timeEntry: {
        findFirst: vi.fn().mockResolvedValue({
          id: ENTRY_ID,
          clientId: CLIENT_ID,
          invoiceId: null,
          description: 'Besprechung',
        }),
        delete: vi.fn().mockResolvedValue({}),
      },
    };
    runWithTx(tx);
    const form = new FormData();
    form.set('id', ENTRY_ID);

    await deleteTimeEntryAction(form);

    expect(m.assertClientAccessTx).toHaveBeenCalledWith(tx, expect.any(Object), CLIENT_ID);
    expect(m.assertClientAccessTx.mock.invocationCallOrder[0]).toBeLessThan(
      tx.timeEntry.delete.mock.invocationCallOrder[0]!,
    );
  });
});
