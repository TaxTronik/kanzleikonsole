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
//
// Fachkatalog: TAX-DEADLINE-AUTOREQUEST-001
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
  const processNotifications = vi.fn();
  const notifyAutomaticTaxRequestOpened = vi.fn();
  const upsertNotificationTx = vi.fn();
  const resolveNotificationsTx = vi.fn();
  const moduleEnabled = vi.fn();
  return {
    prismaOwner,
    tx,
    withWorkerTenantContext,
    record,
    materialize,
    processNotifications,
    notifyAutomaticTaxRequestOpened,
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
vi.mock('../../mail', () => ({
  notifyAutomaticTaxRequestOpened: h.notifyAutomaticTaxRequestOpened,
}));
vi.mock('@taxtronik/db/notification', () => ({
  upsertNotificationTx: h.upsertNotificationTx,
  resolveNotificationsTx: h.resolveNotificationsTx,
}));
vi.mock('@taxtronik/tax', () => ({ materializeTenantTaxDeadlines: h.materialize }));
vi.mock('../tax-deadline-notification', () => ({
  processTaxDeadlineNotifications: h.processNotifications,
}));
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

const STATS = {
  deadlinesCreated: 2,
  requestsCreated: 1,
  markedOverdue: 3,
  staffWarned: 1,
};

beforeEach(() => {
  vi.resetAllMocks();
  h.withWorkerTenantContext.mockImplementation(
    async (_tenantId: string, fn: (t: unknown) => Promise<unknown>) => fn(h.tx),
  );
  h.prismaOwner.tenant.findMany.mockResolvedValue([{ id: TENANT }]);
  h.prismaOwner.staffUser.findFirst.mockResolvedValue({ id: 'staff-1' });
  h.materialize.mockResolvedValue(STATS);
  h.notifyAutomaticTaxRequestOpened.mockResolvedValue({
    ok: true,
    recipients: 2,
    attempted: 2,
    externalSideEffectOccurred: false,
    uncertainFailure: false,
  });
  h.processNotifications.mockResolvedValue({
    processed: 1,
    providerAccepted: 1,
    recipientsAccepted: 2,
    retryPending: 0,
    escalated: 0,
  });
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
    expect(h.processNotifications).not.toHaveBeenCalled();
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

  it('ohne ADMIN/PARTNER werden keine neuen Requests erzeugt, persistierte Benachrichtigungen aber verarbeitet', async () => {
    h.prismaOwner.staffUser.findFirst.mockResolvedValue(null);

    const result = await run();

    expect(h.materialize).not.toHaveBeenCalled();
    expect(h.processNotifications).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ created: 0, requests: 0, overdue: 0, warned: 0, mailRecipients: 2 });
  });
});

describe('Persistierter Benachrichtigungsfluss nach Commit', () => {
  it('delegiert QUEUED/FAILED-Zustaende an den getrennten Processor', async () => {
    await run();

    expect(h.processNotifications).toHaveBeenCalledTimes(1);
    const [deps, input] = h.processNotifications.mock.calls[0]!;
    expect(input).toEqual({ tenantId: TENANT });
    const dispatchInput = {
      tenantId: TENANT,
      clientId: 'client-1',
      requestId: 'req-1',
      priority: 'NORMAL',
      dueAtIso: '2026-06-20T00:00:00.000Z',
    };
    await deps.notifyAutomaticTaxRequestOpened(dispatchInput);
    expect(h.notifyAutomaticTaxRequestOpened).toHaveBeenCalledWith(dispatchInput);
  });

  it('unklare/terminale Versandzustaende failen den Job nicht', async () => {
    h.processNotifications.mockResolvedValue({
      processed: 1,
      providerAccepted: 0,
      recipientsAccepted: 0,
      retryPending: 0,
      escalated: 1,
    });

    const result = await run();

    expect(result).toEqual({ created: 2, requests: 1, overdue: 3, warned: 1, mailRecipients: 0 });
  });

  it('laesst nur eindeutig FAILED fuer BullMQ-Retry fehlschlagen', async () => {
    h.processNotifications.mockResolvedValue({
      processed: 1,
      providerAccepted: 0,
      recipientsAccepted: 0,
      retryPending: 1,
      escalated: 0,
    });

    await expect(run()).rejects.toThrow('warten auf Retry');
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
      })
      .mockResolvedValueOnce({
        deadlinesCreated: 3,
        requestsCreated: 0,
        markedOverdue: 4,
        staffWarned: 0,
      });
    h.processNotifications
      .mockResolvedValueOnce({
        processed: 1,
        providerAccepted: 1,
        recipientsAccepted: 2,
        retryPending: 0,
        escalated: 0,
      })
      .mockResolvedValueOnce({
        processed: 0,
        providerAccepted: 0,
        recipientsAccepted: 0,
        retryPending: 0,
        escalated: 0,
      });

    const result = await run({});

    expect(h.materialize).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ created: 5, requests: 1, overdue: 4, warned: 2, mailRecipients: 2 });
  });
});
