// =============================================================================
// Unit-Tests: tax-deadline-materialize-Worker (Verdrahtungs-Shell).
//
// Die Fachlogik lebt in @taxtronik/tax (materializeTenantTaxDeadlines) und ist
// dort separat getestet (packages/tax/src/__tests__/materialize.test.ts).
// Hier wird nur die Worker-Verdrahtung abgesichert:
//   - DI-Deps: db === prismaOwner, runAtomic delegiert an
//     withWorkerTenantContext(tenantId, …), recordEvidence an EvidenceService
//   - System-Staff: erster aktiver ADMIN/PARTNER; ohne so einen Account → skip
//   - Stats-Summierung über mehrere Tenants
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => {
  const prismaOwner = {
    tenant: { findMany: vi.fn() },
    staffUser: { findFirst: vi.fn() },
  };
  const tx = {};
  const withWorkerTenantContext = vi.fn(
    async (_tenantId: string, fn: (t: unknown) => Promise<unknown>) => fn(tx),
  );
  const record = vi.fn();
  const materialize = vi.fn();
  const notifyRequestOpened = vi.fn();
  const upsertNotificationTx = vi.fn();
  const resolveNotificationsTx = vi.fn();
  const moduleEnabled = vi.fn();
  return {
    prismaOwner,
    tx,
    withWorkerTenantContext,
    record,
    materialize,
    notifyRequestOpened,
    upsertNotificationTx,
    resolveNotificationsTx,
    moduleEnabled,
  };
});

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../prisma-owner', () => ({ prismaOwner: h.prismaOwner }));
vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../tenant-context', () => ({ withWorkerTenantContext: h.withWorkerTenantContext }));
vi.mock('../../module-gate', () => ({
  isWorkerTenantModuleEnabled: h.moduleEnabled,
}));
vi.mock('../../mail', () => ({ notifyRequestOpened: h.notifyRequestOpened }));
vi.mock('@taxtronik/db/notification', () => ({
  upsertNotificationTx: h.upsertNotificationTx,
  resolveNotificationsTx: h.resolveNotificationsTx,
}));
vi.mock('@taxtronik/tax', () => ({ materializeTenantTaxDeadlines: h.materialize }));
vi.mock('@taxtronik/evidence', () => ({
  EvidenceService: class {
    record = h.record;
  },
  LocalTimestampAdapter: class {},
}));

import { processors } from './mocks/bullmq';
import '../tax-deadline-materialize';

const TENANT = 'tenant-1';

interface MaterializeResult {
  created: number;
  requests: number;
  overdue: number;
  warned: number;
  mailRecipients: number;
}

function run(data: { tenantId?: string } = { tenantId: TENANT }): Promise<MaterializeResult> {
  return processors.get('tax-deadline-materialize')!({ data }) as Promise<MaterializeResult>;
}

const CREATED_REQUEST = {
  tenantId: TENANT,
  clientId: 'client-1',
  deadlineId: 'dl-1',
  requestId: 'req-1',
  kind: 'USTA_MONATLICH',
  period: '2026-05',
  dueDate: new Date(Date.UTC(2026, 5, 20)),
  title: 'USt-Voranmeldung (monatlich) 2026-05 bis 20.6.2026',
  description: 'Bitte stellen Sie die Unterlagen bereit.',
  priority: 'NORMAL' as const,
};

const STATS = {
  deadlinesCreated: 2,
  requestsCreated: 1,
  markedOverdue: 3,
  staffWarned: 1,
  createdRequests: [CREATED_REQUEST],
};

beforeEach(() => {
  vi.resetAllMocks();
  h.withWorkerTenantContext.mockImplementation(
    async (_tenantId: string, fn: (t: unknown) => Promise<unknown>) => fn(h.tx),
  );
  h.prismaOwner.tenant.findMany.mockResolvedValue([{ id: TENANT }]);
  h.prismaOwner.staffUser.findFirst.mockResolvedValue({ id: 'staff-1' });
  h.materialize.mockResolvedValue(STATS);
  h.notifyRequestOpened.mockResolvedValue({ ok: true, recipients: 2 });
  h.record.mockResolvedValue({});
  h.moduleEnabled.mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Verdrahtung des DI-Kerns', () => {
  it('überspringt den direkten Worker-Einstieg bei deaktivierten Steuerbescheiden', async () => {
    h.moduleEnabled.mockResolvedValue(false);

    await expect(run()).resolves.toEqual({
      created: 0,
      requests: 0,
      overdue: 0,
      warned: 0,
      mailRecipients: 0,
    });

    expect(h.prismaOwner.staffUser.findFirst).not.toHaveBeenCalled();
    expect(h.materialize).not.toHaveBeenCalled();
  });

  it('übergibt prismaOwner als db und die korrekten Params (horizonDays 90)', async () => {
    const result = await run();

    expect(h.materialize).toHaveBeenCalledTimes(1);
    const [deps, params] = h.materialize.mock.calls[0]!;
    expect(deps.db).toBe(h.prismaOwner);
    expect(params).toEqual({ tenantId: TENANT, systemStaffId: 'staff-1', horizonDays: 90 });
    expect(result).toEqual({ created: 2, requests: 1, overdue: 3, warned: 1, mailRecipients: 2 });
  });

  it('upsertStaffNotification delegiert an upsertNotificationTx mit demselben Tx', async () => {
    await run();

    const [deps] = h.materialize.mock.calls[0]!;
    const input = { kind: 'TAX_DEADLINE_REQUEST_PENDING' };
    await deps.upsertStaffNotification(h.tx, input);
    expect(h.upsertNotificationTx).toHaveBeenCalledTimes(1);
    expect(h.upsertNotificationTx.mock.calls[0]![0]).toBe(h.tx);
    expect(h.upsertNotificationTx.mock.calls[0]![1]).toBe(input);
  });

  it('resolveStaffNotifications schließt die Termin-Notification im selben Tx', async () => {
    await run();

    const [deps] = h.materialize.mock.calls[0]!;
    const input = { tenantId: TENANT, resourceType: 'tax_deadline', resourceId: 'dl-1' };
    await deps.resolveStaffNotifications(h.tx, input);
    expect(h.resolveNotificationsTx).toHaveBeenCalledWith(h.tx, {
      tenantId: TENANT,
      resources: [{ resourceType: 'tax_deadline', resourceId: 'dl-1' }],
    });
  });

  it('runAtomic delegiert an withWorkerTenantContext mit der Tenant-Id', async () => {
    await run();

    const [deps] = h.materialize.mock.calls[0]!;
    const inner = vi.fn().mockResolvedValue('ok');
    await expect(deps.runAtomic(inner)).resolves.toBe('ok');
    expect(h.withWorkerTenantContext).toHaveBeenCalledTimes(1);
    expect(h.withWorkerTenantContext.mock.calls[0]![0]).toBe(TENANT);
    // Die Callback-Funktion bekommt den Tx-Client des Tenant-Contexts
    expect(inner.mock.calls[0]![0]).toBe(h.tx);
  });

  it('recordEvidence delegiert an EvidenceService.record mit demselben Tx', async () => {
    await run();

    const [deps] = h.materialize.mock.calls[0]!;
    const event = { action: 'tax_deadline.auto_request' };
    await deps.recordEvidence(h.tx, event);
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.record.mock.calls[0]![0]).toBe(h.tx);
    expect(h.record.mock.calls[0]![1]).toBe(event);
  });
});

describe('System-Staff-Auswahl', () => {
  it('sucht den ersten aktiven ADMIN/PARTNER des Tenants', async () => {
    await run();

    expect(h.prismaOwner.staffUser.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT,
        active: true,
        roles: { some: { role: { in: ['ADMIN', 'PARTNER'] } } },
      },
      select: { id: true },
    });
  });

  it('ohne ADMIN/PARTNER wird der Tenant übersprungen', async () => {
    h.prismaOwner.staffUser.findFirst.mockResolvedValue(null);

    const result = await run();

    expect(h.materialize).not.toHaveBeenCalled();
    expect(result).toEqual({ created: 0, requests: 0, overdue: 0, warned: 0, mailRecipients: 0 });
  });
});

describe('Mandanten-Mail nach Commit', () => {
  it('versendet pro createdRequest genau eine request-opened-Benachrichtigung', async () => {
    await run();

    expect(h.notifyRequestOpened).toHaveBeenCalledTimes(1);
    expect(h.notifyRequestOpened).toHaveBeenCalledWith({
      tenantId: TENANT,
      clientId: 'client-1',
      requestId: 'req-1',
      title: 'USt-Voranmeldung (monatlich) 2026-05 bis 20.6.2026',
      description: 'Bitte stellen Sie die Unterlagen bereit.',
      priority: 'NORMAL',
      dueAtIso: '2026-06-20T00:00:00.000Z',
    });
  });

  it('ein Mail-Fehler failt den Job NICHT (Termin ist bereits REMINDED)', async () => {
    h.notifyRequestOpened.mockRejectedValue(new Error('SMTP down'));

    const result = await run();

    expect(result).toEqual({ created: 2, requests: 1, overdue: 3, warned: 1, mailRecipients: 0 });
  });
});

describe('Multi-Tenant', () => {
  it('summiert die Stats über alle Tenants', async () => {
    h.prismaOwner.tenant.findMany.mockResolvedValue([{ id: 'tenant-a' }, { id: 'tenant-b' }]);
    h.materialize
      .mockResolvedValueOnce({
        deadlinesCreated: 2,
        requestsCreated: 1,
        markedOverdue: 0,
        staffWarned: 2,
        createdRequests: [CREATED_REQUEST],
      })
      .mockResolvedValueOnce({
        deadlinesCreated: 3,
        requestsCreated: 0,
        markedOverdue: 4,
        staffWarned: 0,
        createdRequests: [],
      });

    const result = await run({});

    expect(h.materialize).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ created: 5, requests: 1, overdue: 4, warned: 2, mailRecipients: 2 });
  });
});
