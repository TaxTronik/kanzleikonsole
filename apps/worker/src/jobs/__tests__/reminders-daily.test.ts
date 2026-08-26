// Fachregeln: TAX-NOTICE-APPEAL-001, TAX-CONTROL-STATUS-001

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const prismaOwner = {
    tenant: { findMany: vi.fn() },
    taxNotice: { findMany: vi.fn() },
    clientReminder: { findMany: vi.fn() },
    pendingBinder: { findMany: vi.fn() },
  };
  const tx = {
    $queryRaw: vi.fn(),
    notification: { findMany: vi.fn(), createMany: vi.fn() },
    taxNotice: { findMany: vi.fn() },
    clientReminder: { findMany: vi.fn() },
    pendingBinder: { findMany: vi.fn() },
    clientResponsibility: { findMany: vi.fn() },
    staffUser: { findMany: vi.fn() },
  };
  const withWorkerTenantContext = vi.fn(
    async (_tenantId: string, fn: (value: typeof tx) => Promise<unknown>) => fn(tx),
  );
  return {
    prismaOwner,
    tx,
    withWorkerTenantContext,
    readWorkerTenantModules: vi.fn(),
    filterStaffAccessClientTx: vi.fn(),
  };
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
vi.mock('../../module-gate', () => ({
  readWorkerTenantModules: h.readWorkerTenantModules,
}));
vi.mock('@taxtronik/db/staff-client-access', () => ({
  filterStaffAccessClientTx: h.filterStaffAccessClientTx,
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
  h.readWorkerTenantModules.mockResolvedValue({
    taxNotices: true,
    reminders: true,
    binders: true,
  });
  h.tx.notification.findMany.mockResolvedValue([]);
  h.tx.$queryRaw.mockResolvedValue([]);
  h.tx.taxNotice.findMany.mockResolvedValue([]);
  h.tx.clientReminder.findMany.mockResolvedValue([]);
  h.tx.pendingBinder.findMany.mockResolvedValue([]);
  h.tx.clientResponsibility.findMany.mockResolvedValue([]);
  h.tx.staffUser.findMany.mockResolvedValue([]);
  h.tx.notification.createMany.mockImplementation(async ({ data }: { data: unknown[] }) => ({
    count: data.length,
  }));
  h.filterStaffAccessClientTx.mockImplementation(
    async (_tx: unknown, _tenantId: string, ids: readonly string[]) => new Set(ids),
  );
  h.withWorkerTenantContext.mockImplementation(
    async (_tenantId: string, fn: (value: typeof h.tx) => Promise<unknown>) => fn(h.tx),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe('reminders-daily Query- und Bulk-Dedupe', () => {
  it('fragt bei deaktivierten Teilmodulen keine ihrer Tabellen ab', async () => {
    h.readWorkerTenantModules.mockResolvedValue({
      taxNotices: false,
      reminders: false,
      binders: false,
    });

    await expect(run()).resolves.toEqual({ appeal: 0, reminders: 0, binders: 0 });

    expect(h.prismaOwner.taxNotice.findMany).not.toHaveBeenCalled();
    expect(h.prismaOwner.clientReminder.findMany).not.toHaveBeenCalled();
    expect(h.prismaOwner.pendingBinder.findMany).not.toHaveBeenCalled();
    expect(h.withWorkerTenantContext).not.toHaveBeenCalled();
  });

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
          deadlineCalculationStatus: 'CALCULATED',
          manualReviewRequired: false,
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
        reviewedBy: 'staff-existing',
        deadlineCalculationStatus: 'CALCULATED',
        manualReviewRequired: false,
        client: { id: 'client-1', name: 'Muster GmbH' },
      },
      {
        id: 'notice-new',
        kind: 'UMSATZSTEUER',
        period: '2025',
        appealDeadline: new Date('2026-07-23T00:00:00.000Z'),
        reviewedBy: 'staff-1',
        deadlineCalculationStatus: 'CALCULATED',
        manualReviewRequired: false,
        client: { id: 'client-1', name: 'Muster GmbH' },
      },
    ]);
    h.tx.taxNotice.findMany.mockResolvedValue([
      {
        id: 'notice-existing',
        clientId: 'client-1',
        reviewedBy: 'staff-existing',
        appealDeadline: new Date('2026-07-17T00:00:00.000Z'),
        deadlineCalculationStatus: 'CALCULATED',
        manualReviewRequired: false,
      },
      {
        id: 'notice-new',
        clientId: 'client-1',
        reviewedBy: 'staff-1',
        appealDeadline: new Date('2026-07-23T00:00:00.000Z'),
        deadlineCalculationStatus: 'CALCULATED',
        manualReviewRequired: false,
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
    h.tx.clientReminder.findMany.mockResolvedValue([
      {
        id: 'reminder-1',
        clientId: 'client-1',
        dueDate: new Date('2026-07-16T00:00:00.000Z'),
        createdByStaff: 'staff-2',
        assignees: [],
      },
    ]);
    h.tx.pendingBinder.findMany.mockResolvedValue([
      {
        id: 'binder-1',
        clientId: 'client-1',
        createdByStaff: 'staff-3',
        expectedReturnAt: new Date('2026-07-15T00:00:00.000Z'),
      },
    ]);
    h.tx.notification.findMany.mockResolvedValue([
      {
        staffId: 'staff-existing',
        kind: 'TAX_NOTICE_APPEAL_REMINDER',
        resourceId: 'notice-existing',
      },
    ]);

    const result = await run();

    expect(h.withWorkerTenantContext).toHaveBeenCalledTimes(1);
    expect(h.tx.$queryRaw).toHaveBeenCalledTimes(3);
    const lockSql = h.tx.$queryRaw.mock.calls.map((call) => (call[0] as { sql: string }).sql);
    expect(lockSql[0]).toContain('FROM public."tax_notice"');
    expect(lockSql[1]).toContain('FROM public."client_reminder"');
    expect(lockSql[2]).toContain('FROM public."pending_binder"');
    for (const sql of lockSql) {
      expect(sql).toContain('ORDER BY "id"');
      expect(sql).toContain('FOR UPDATE');
    }
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

  it('TAX-NOTICE-APPEAL-001: NEU ohne Prüfer geht nur an aktive Hauptbearbeiter', async () => {
    h.prismaOwner.taxNotice.findMany.mockResolvedValue([
      {
        id: 'notice-neu',
        kind: 'EINKOMMENSTEUER',
        period: '2025',
        appealDeadline: new Date('2026-07-17T00:00:00.000Z'),
        reviewedBy: null,
        deadlineCalculationStatus: 'CALCULATED',
        manualReviewRequired: false,
        client: { id: 'client-neu', name: 'Neu GmbH' },
      },
    ]);
    h.tx.taxNotice.findMany.mockResolvedValue([
      {
        id: 'notice-neu',
        clientId: 'client-neu',
        reviewedBy: null,
        appealDeadline: new Date('2026-07-17T00:00:00.000Z'),
        deadlineCalculationStatus: 'CALCULATED',
        manualReviewRequired: false,
      },
    ]);
    h.tx.clientResponsibility.findMany.mockResolvedValue([
      { clientId: 'client-neu', staffId: 'hb-aktiv' },
    ]);

    await expect(run()).resolves.toEqual({ appeal: 1, reminders: 0, binders: 0 });

    expect(h.tx.clientResponsibility.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT_ID,
        clientId: { in: ['client-neu'] },
        role: 'HAUPTBEARBEITER',
        staff: { tenantId: TENANT_ID, active: true },
      },
      select: { clientId: true, staffId: true },
    });
    const inserted = h.tx.notification.createMany.mock.calls.flatMap(
      (call) => (call[0] as { data: Array<Record<string, unknown>> }).data,
    );
    expect(inserted).toEqual([
      expect.objectContaining({ resourceId: 'notice-neu', staffId: 'hb-aktiv' }),
    ]);
    expect(inserted).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ staffId: null })]),
    );
    expect(h.tx.staffUser.findMany).not.toHaveBeenCalled();
  });

  it.each(['OPEN→RESTRICTED', 'nachtraeglich vertraulich'])(
    'TAX-CONTROL-STATUS-001: %s entzieht dem alten Prüfer den Reminder-Zugriff',
    async () => {
      h.prismaOwner.taxNotice.findMany.mockResolvedValue([
        {
          id: 'notice-vertraulich',
          kind: 'UMSATZSTEUER',
          period: '2025',
          appealDeadline: new Date('2026-07-23T00:00:00.000Z'),
          reviewedBy: 'staff-alt',
          deadlineCalculationStatus: 'CALCULATED',
          manualReviewRequired: false,
          client: { id: 'client-vertraulich', name: 'Geheim GmbH' },
        },
      ]);
      h.tx.taxNotice.findMany.mockResolvedValue([
        {
          id: 'notice-vertraulich',
          clientId: 'client-vertraulich',
          reviewedBy: 'staff-alt',
          appealDeadline: new Date('2026-07-23T00:00:00.000Z'),
          deadlineCalculationStatus: 'CALCULATED',
          manualReviewRequired: false,
        },
      ]);
      h.tx.clientResponsibility.findMany.mockResolvedValue([
        { clientId: 'client-vertraulich', staffId: 'hb-aktuell' },
      ]);
      h.filterStaffAccessClientTx.mockImplementation(
        async (_tx: unknown, _tenantId: string, ids: readonly string[]) =>
          new Set(ids.filter((id) => id === 'hb-aktuell')),
      );

      await expect(run()).resolves.toEqual({ appeal: 1, reminders: 0, binders: 0 });

      const inserted = h.tx.notification.createMany.mock.calls.flatMap(
        (call) => (call[0] as { data: Array<Record<string, unknown>> }).data,
      );
      expect(inserted).toEqual([
        expect.objectContaining({ resourceId: 'notice-vertraulich', staffId: 'hb-aktuell' }),
      ]);
      expect(inserted).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ staffId: 'staff-alt' }),
          expect.objectContaining({ staffId: null }),
        ]),
      );
    },
  );

  it('nutzt ohne berechtigten Prüfer oder Hauptbearbeiter aktive ADMIN/PARTNER', async () => {
    h.prismaOwner.taxNotice.findMany.mockResolvedValue([
      {
        id: 'notice-fallback',
        kind: 'EINKOMMENSTEUER',
        period: '2025',
        appealDeadline: new Date('2026-07-17T00:00:00.000Z'),
        reviewedBy: null,
        deadlineCalculationStatus: 'CALCULATED',
        manualReviewRequired: false,
        client: { id: 'client-fallback', name: 'Fallback GmbH' },
      },
    ]);
    h.tx.taxNotice.findMany.mockResolvedValue([
      {
        id: 'notice-fallback',
        clientId: 'client-fallback',
        reviewedBy: null,
        appealDeadline: new Date('2026-07-17T00:00:00.000Z'),
        deadlineCalculationStatus: 'CALCULATED',
        manualReviewRequired: false,
      },
    ]);
    h.tx.staffUser.findMany.mockResolvedValue([{ id: 'partner-aktiv' }]);

    await expect(run()).resolves.toEqual({ appeal: 1, reminders: 0, binders: 0 });

    expect(h.tx.staffUser.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT_ID,
        active: true,
        roles: { some: { role: { in: ['ADMIN', 'PARTNER'] } } },
      },
      select: { id: true },
    });
    const inserted = h.tx.notification.createMany.mock.calls.flatMap(
      (call) => (call[0] as { data: Array<Record<string, unknown>> }).data,
    );
    expect(inserted).toEqual([
      expect.objectContaining({ resourceId: 'notice-fallback', staffId: 'partner-aktiv' }),
    ]);
  });

  it('TAX-NOTICE-APPEAL-001: §122a-Vorschlag mit manuellem Prüfbedarf erzeugt keinen Frist-Reminder', async () => {
    h.prismaOwner.taxNotice.findMany.mockResolvedValue([
      {
        id: 'notice-122a-offen',
        kind: 'EINKOMMENSTEUER',
        period: '2025',
        appealDeadline: new Date('2026-07-17T00:00:00.000Z'),
        reviewedBy: 'staff-1',
        deadlineCalculationStatus: 'CALCULATED',
        manualReviewRequired: true,
        client: { id: 'client-1', name: 'Muster GmbH' },
      },
    ]);

    await expect(run()).resolves.toEqual({ appeal: 0, reminders: 0, binders: 0 });

    expect(h.withWorkerTenantContext).not.toHaveBeenCalled();
    expect(h.tx.notification.createMany).not.toHaveBeenCalled();
  });

  it('revalidiert die fachliche Fristqualifikation unmittelbar im Insert-Tx', async () => {
    h.prismaOwner.taxNotice.findMany.mockResolvedValue([
      {
        id: 'notice-race',
        kind: 'EINKOMMENSTEUER',
        period: '2025',
        appealDeadline: new Date('2026-07-17T00:00:00.000Z'),
        reviewedBy: 'staff-1',
        deadlineCalculationStatus: 'CALCULATED',
        manualReviewRequired: false,
        client: { id: 'client-1', name: 'Muster GmbH' },
      },
    ]);
    // Zwischen Kandidaten-Read und Insert ist der Vorschlag wieder fachlich offen.
    h.tx.taxNotice.findMany.mockResolvedValue([
      {
        id: 'notice-race',
        clientId: 'client-1',
        reviewedBy: 'staff-1',
        appealDeadline: new Date('2026-07-17T00:00:00.000Z'),
        deadlineCalculationStatus: 'CALCULATED',
        manualReviewRequired: true,
      },
    ]);

    await expect(run()).resolves.toEqual({ appeal: 0, reminders: 0, binders: 0 });

    expect(h.tx.taxNotice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: TENANT_ID,
          deadlineCalculationStatus: 'CALCULATED',
          manualReviewRequired: false,
        }),
      }),
    );
    expect(h.tx.notification.createMany).not.toHaveBeenCalled();
  });

  it.each(['OPEN→RESTRICTED ohne Verantwortung', 'nachtraeglich vertraulich ohne Verantwortung'])(
    '%s: alte Reminder-Zuweisung erzeugt keine Notification',
    async () => {
      h.prismaOwner.clientReminder.findMany.mockResolvedValue([
        {
          id: 'reminder-stale',
          dueDate: new Date('2026-07-16T00:00:00.000Z'),
          subject: 'Nicht mehr sichtbarer Sachverhalt',
          assignees: [{ staffId: 'staff-alt' }],
          createdByStaff: 'staff-creator',
          client: { id: 'client-vertraulich', name: 'Geheim GmbH' },
        },
      ]);
      h.tx.clientReminder.findMany.mockResolvedValue([
        {
          id: 'reminder-stale',
          clientId: 'client-vertraulich',
          dueDate: new Date('2026-07-16T00:00:00.000Z'),
          createdByStaff: 'staff-creator',
          assignees: [{ staffId: 'staff-alt' }],
        },
      ]);
      h.filterStaffAccessClientTx.mockResolvedValue(new Set());

      await expect(run()).resolves.toEqual({ appeal: 0, reminders: 0, binders: 0 });

      expect(h.filterStaffAccessClientTx).toHaveBeenCalledWith(
        h.tx,
        TENANT_ID,
        ['staff-alt'],
        'client-vertraulich',
      );
      expect(h.tx.notification.createMany).not.toHaveBeenCalled();
    },
  );

  it('verwendet bei einer zwischenzeitlich neu zugewiesenen Wiedervorlage nur aktuelle Empfänger', async () => {
    h.prismaOwner.clientReminder.findMany.mockResolvedValue([
      {
        id: 'reminder-reassigned',
        dueDate: new Date('2026-07-16T00:00:00.000Z'),
        subject: 'Aktuelle Zuweisung',
        assignees: [{ staffId: 'staff-alt' }],
        createdByStaff: 'staff-creator',
        client: { id: 'client-1', name: 'Muster GmbH' },
      },
    ]);
    h.tx.clientReminder.findMany.mockResolvedValue([
      {
        id: 'reminder-reassigned',
        clientId: 'client-1',
        dueDate: new Date('2026-07-16T00:00:00.000Z'),
        createdByStaff: 'staff-creator',
        assignees: [{ staffId: 'staff-neu' }],
      },
    ]);

    await expect(run()).resolves.toEqual({ appeal: 0, reminders: 1, binders: 0 });

    const inserted = h.tx.notification.createMany.mock.calls.flatMap(
      (call) => (call[0] as { data: Array<Record<string, unknown>> }).data,
    );
    expect(inserted).toEqual([
      expect.objectContaining({ resourceId: 'reminder-reassigned', staffId: 'staff-neu' }),
    ]);
    expect(inserted).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ staffId: 'staff-alt' })]),
    );
  });

  it('verwirft eine zwischen Kandidaten-Read und Insert erledigte Wiedervorlage', async () => {
    h.prismaOwner.clientReminder.findMany.mockResolvedValue([
      {
        id: 'reminder-done',
        dueDate: new Date('2026-07-16T00:00:00.000Z'),
        subject: 'Inzwischen erledigt',
        assignees: [{ staffId: 'staff-1' }],
        createdByStaff: 'staff-creator',
        client: { id: 'client-1', name: 'Muster GmbH' },
      },
    ]);
    h.tx.clientReminder.findMany.mockResolvedValue([]);

    await expect(run()).resolves.toEqual({ appeal: 0, reminders: 0, binders: 0 });

    expect(h.tx.clientReminder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: TENANT_ID,
          doneAt: null,
          dueDate: { in: [new Date('2026-07-16T00:00:00.000Z')] },
        }),
      }),
    );
    expect(h.tx.notification.createMany).not.toHaveBeenCalled();
  });

  it('verwirft eine interne Wiedervorlage an einen inzwischen inaktiven Empfänger', async () => {
    h.prismaOwner.clientReminder.findMany.mockResolvedValue([
      {
        id: 'reminder-internal',
        dueDate: new Date('2026-07-16T00:00:00.000Z'),
        subject: 'Interne Aufgabe',
        assignees: [{ staffId: 'staff-inaktiv' }],
        createdByStaff: 'staff-creator',
        client: null,
      },
    ]);
    h.tx.clientReminder.findMany.mockResolvedValue([
      {
        id: 'reminder-internal',
        clientId: null,
        dueDate: new Date('2026-07-16T00:00:00.000Z'),
        createdByStaff: 'staff-creator',
        assignees: [{ staffId: 'staff-inaktiv' }],
      },
    ]);
    h.tx.staffUser.findMany.mockResolvedValue([]);

    await expect(run()).resolves.toEqual({ appeal: 0, reminders: 0, binders: 0 });

    expect(h.tx.staffUser.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['staff-inaktiv'] }, tenantId: TENANT_ID, active: true },
      select: { id: true },
    });
    expect(h.tx.notification.createMany).not.toHaveBeenCalled();
  });

  it.each(['entzogener Mandantenzugriff', 'deaktivierter Ersteller'])(
    'Pendelordner mit %s erzeugt keine vertrauliche Notification',
    async () => {
      h.prismaOwner.pendingBinder.findMany.mockResolvedValue([
        {
          id: 'binder-sensitive',
          label: 'Vertrauliche Unterlagen',
          expectedReturnAt: new Date('2026-07-15T00:00:00.000Z'),
          createdByStaff: 'staff-alt',
          client: { id: 'client-vertraulich', name: 'Geheim GmbH' },
        },
      ]);
      h.tx.pendingBinder.findMany.mockResolvedValue([
        {
          id: 'binder-sensitive',
          clientId: 'client-vertraulich',
          createdByStaff: 'staff-alt',
          expectedReturnAt: new Date('2026-07-15T00:00:00.000Z'),
        },
      ]);
      h.filterStaffAccessClientTx.mockResolvedValue(new Set());

      await expect(run()).resolves.toEqual({ appeal: 0, reminders: 0, binders: 0 });

      expect(h.tx.pendingBinder.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tenantId: TENANT_ID,
            status: 'WITH_CLIENT',
            expectedReturnAt: { in: [new Date('2026-07-15T00:00:00.000Z')] },
          }),
        }),
      );
      expect(h.filterStaffAccessClientTx).toHaveBeenCalledWith(
        h.tx,
        TENANT_ID,
        ['staff-alt'],
        'client-vertraulich',
      );
      expect(h.tx.notification.createMany).not.toHaveBeenCalled();
    },
  );
});
