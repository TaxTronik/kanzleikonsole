import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  staffActionGuard: vi.fn(),
  withTenantContext: vi.fn(),
  resolveNotificationsTx: vi.fn(),
  evidenceRecord: vi.fn(),
  materializeTaxDeadlines: vi.fn(),
  assertClientAccessTx: vi.fn(),
  assertClientInTenant: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: h.withTenantContext }));
vi.mock('@taxtronik/db/notification', () => ({
  resolveNotificationsTx: h.resolveNotificationsTx,
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.evidenceRecord } }));
vi.mock('@/server/tax-deadlines/materialize', () => ({
  materializeTaxDeadlines: h.materializeTaxDeadlines,
}));
vi.mock('@/server/mail/dispatch', () => ({ notifyRequestOpened: vi.fn() }));
vi.mock('@/server/util/fire-and-forget', () => ({ fireAndForget: vi.fn() }));
vi.mock('@/server/db/assert-tenant', () => ({ assertClientInTenant: h.assertClientInTenant }));
vi.mock('@/server/auth/rbac', () => ({ assertClientAccessTx: h.assertClientAccessTx }));
vi.mock('@/server/actions/staff-action', () => ({ staffActionGuard: h.staffActionGuard }));

import { saveScheduleConfigAction } from '../actions';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';

describe('Steuertermin-Neuplanung', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.staffActionGuard.mockResolvedValue({
      ok: true,
      tenantId: 'tenant-1',
      staffId: 'staff-1',
      session: {},
      ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
    });
    h.materializeTaxDeadlines.mockResolvedValue({ createdRequests: [] });
    h.resolveNotificationsTx.mockResolvedValue(2);
    h.evidenceRecord.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('schließt Hinweise für gelöschte Termine und deren stornierte Anforderung', async () => {
    const tx = {
      taxScheduleConfig: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'config-1',
            kind: 'EST_VZ',
            active: true,
            hasDauerfrist: false,
            advised: false,
            autoRequest: true,
            reminderDaysBefore: 10,
            staffLeadDays: 3,
          },
        ]),
        update: vi.fn().mockResolvedValue(undefined),
      },
      taxDeadline: {
        findMany: vi.fn().mockResolvedValue([{ id: 'deadline-1', requestId: 'request-1' }]),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      request: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    h.withTenantContext.mockImplementation(
      async (_ctx: unknown, run: (client: typeof tx) => unknown) => run(tx),
    );
    const formData = new FormData();
    formData.set('clientId', CLIENT_ID);

    const result = await saveScheduleConfigAction(null, formData);

    expect(result.ok).toBe(true);
    expect(h.resolveNotificationsTx).toHaveBeenCalledWith(tx, {
      tenantId: 'tenant-1',
      resources: [
        { resourceType: 'tax_deadline', resourceId: 'deadline-1' },
        { resourceType: 'request', resourceId: 'request-1' },
      ],
    });
    expect(tx.taxDeadline.deleteMany).toHaveBeenCalledAfter(h.resolveNotificationsTx);
  });

  it('verwendet an der UTC-/Berlin-Tagesgrenze den Berliner Kalendertag', async () => {
    vi.useFakeTimers();
    // In Berlin ist bereits der 10. Juni (00:30 MESZ), UTC noch der 9. Juni.
    vi.setSystemTime(new Date('2026-06-09T22:30:00.000Z'));
    const tx = {
      taxScheduleConfig: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'config-1',
            kind: 'EST_VZ',
            active: true,
            hasDauerfrist: false,
            advised: false,
            autoRequest: false,
            reminderDaysBefore: 10,
            staffLeadDays: 3,
          },
        ]),
        update: vi.fn().mockResolvedValue(undefined),
      },
      taxDeadline: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn(),
      },
      request: { updateMany: vi.fn() },
    };
    h.withTenantContext.mockImplementation(
      async (_ctx: unknown, run: (client: typeof tx) => unknown) => run(tx),
    );
    const formData = new FormData();
    formData.set('clientId', CLIENT_ID);

    await expect(saveScheduleConfigAction(null, formData)).resolves.toMatchObject({ ok: true });

    expect(tx.taxDeadline.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          dueDate: { gte: new Date('2026-06-10T00:00:00.000Z') },
        }),
      }),
    );
  });
});
