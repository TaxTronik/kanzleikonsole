import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const prismaOwner = {
    tenant: { findMany: vi.fn() },
    taxNotice: { findMany: vi.fn() },
    clientReminder: { findMany: vi.fn() },
    pendingBinder: { findMany: vi.fn() },
  };
  const tx = {
    notification: { findMany: vi.fn(), createMany: vi.fn() },
  };
  const withWorkerTenantContext = vi.fn(
    async (_tenantId: string, fn: (value: typeof tx) => Promise<unknown>) => fn(tx),
  );
  return { prismaOwner, tx, withWorkerTenantContext };
});

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../prisma-owner', () => ({ prismaOwner: h.prismaOwner }));
vi.mock('../../tenant-context', () => ({
  withWorkerTenantContext: h.withWorkerTenantContext,
}));

import { processors } from './mocks/bullmq';
import '../reminders-daily';

const TENANT_ID = 'tenant-1';
const NOW = new Date('2026-07-16T10:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

interface ReminderResult {
  appeal: number;
  reminders: number;
  binders: number;
}

function run(): Promise<ReminderResult> {
  return processors.get('reminders-daily')!({
    data: { tenantId: TENANT_ID },
  }) as Promise<ReminderResult>;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.resetAllMocks();
  h.prismaOwner.tenant.findMany.mockResolvedValue([{ id: TENANT_ID }]);
  h.prismaOwner.taxNotice.findMany.mockResolvedValue([]);
  h.prismaOwner.clientReminder.findMany.mockResolvedValue([]);
  h.prismaOwner.pendingBinder.findMany.mockResolvedValue([]);
  h.tx.notification.findMany.mockResolvedValue([]);
  h.tx.notification.createMany.mockImplementation(async ({ data }: { data: unknown[] }) => ({
    count: data.length,
  }));
  h.withWorkerTenantContext.mockImplementation(
    async (_tenantId: string, fn: (value: typeof h.tx) => Promise<unknown>) => fn(h.tx),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe('reminders-daily Query- und Bulk-Dedupe', () => {
  it('fragt Einspruchsfristen ausschließlich für 1, 7 und 14 Tage ab', async () => {
    await run();

    const today = new Date('2026-07-16T00:00:00.000Z');
    expect(h.prismaOwner.taxNotice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: TENANT_ID,
          appealDeadline: {
            in: [1, 7, 14].map((days) => new Date(today.getTime() + days * DAY_MS)),
          },
        }),
      }),
    );
    expect(h.withWorkerTenantContext).not.toHaveBeenCalled();
  });

  it('lädt heutige Dedupe-Keys einmal und schreibt sanitisiert per createMany', async () => {
    h.prismaOwner.taxNotice.findMany.mockResolvedValue([
      {
        id: 'notice-existing',
        kind: 'EINKOMMENSTEUER',
        period: '2025',
        appealDeadline: new Date('2026-07-17T00:00:00.000Z'),
        reviewedBy: null,
        client: { id: 'client-1', name: 'Muster GmbH' },
      },
      {
        id: 'notice-new',
        kind: 'UMSATZSTEUER',
        period: '2025',
        appealDeadline: new Date('2026-07-23T00:00:00.000Z'),
        reviewedBy: 'staff-1',
        client: { id: 'client-1', name: 'Muster GmbH' },
      },
    ]);
    h.prismaOwner.clientReminder.findMany.mockResolvedValue([
      {
        id: 'reminder-1',
        dueDate: new Date('2026-07-16T00:00:00.000Z'),
        subject: '<script>',
        // Ohne Zuweisung erinnert sich die anlegende Person selbst.
        assignees: [],
        createdByStaff: 'staff-2',
        client: { id: 'client-1', name: 'Muster GmbH' },
      },
    ]);
    h.prismaOwner.pendingBinder.findMany.mockResolvedValue([
      {
        id: 'binder-1',
        label: 'Juni',
        expectedReturnAt: new Date('2026-07-15T00:00:00.000Z'),
        createdByStaff: 'staff-3',
        client: { id: 'client-1', name: 'Muster GmbH' },
      },
    ]);
    h.tx.notification.findMany.mockResolvedValue([
      {
        staffId: null,
        kind: 'TAX_NOTICE_APPEAL_REMINDER',
        resourceId: 'notice-existing',
      },
    ]);

    const result = await run();

    expect(h.withWorkerTenantContext).toHaveBeenCalledTimes(1);
    expect(h.tx.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: TENANT_ID,
          createdAt: {
            gte: new Date('2026-07-16T00:00:00.000Z'),
            lt: new Date('2026-07-17T00:00:00.000Z'),
          },
        }),
        select: { staffId: true, kind: true, resourceId: true },
      }),
    );
    expect(h.tx.notification.createMany).toHaveBeenCalledTimes(3);
    for (const call of h.tx.notification.createMany.mock.calls) {
      expect(call[0]).toMatchObject({ skipDuplicates: true });
    }

    const inserted = h.tx.notification.createMany.mock.calls.flatMap(
      (call) => (call[0] as { data: Array<Record<string, unknown>> }).data,
    );
    expect(inserted).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ resourceId: 'notice-existing' })]),
    );
    expect(inserted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resourceId: 'reminder-1',
          title: 'Wiedervorlage fällig: ‹script>',
        }),
      ]),
    );
    expect(result).toEqual({ appeal: 1, reminders: 1, binders: 1 });
  });
});
