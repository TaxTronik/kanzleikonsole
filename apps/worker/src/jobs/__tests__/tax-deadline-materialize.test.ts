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
  return { prismaOwner, tx, withWorkerTenantContext, record, materialize };
});

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../prisma-owner', () => ({ prismaOwner: h.prismaOwner }));
vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../tenant-context', () => ({ withWorkerTenantContext: h.withWorkerTenantContext }));
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
}

function run(data: { tenantId?: string } = { tenantId: TENANT }): Promise<MaterializeResult> {
  return processors.get('tax-deadline-materialize')!({ data }) as Promise<MaterializeResult>;
}

const STATS = { deadlinesCreated: 2, requestsCreated: 1, markedOverdue: 3 };

beforeEach(() => {
  vi.resetAllMocks();
  h.withWorkerTenantContext.mockImplementation(
    async (_tenantId: string, fn: (t: unknown) => Promise<unknown>) => fn(h.tx),
  );
  h.prismaOwner.tenant.findMany.mockResolvedValue([{ id: TENANT }]);
  h.prismaOwner.staffUser.findFirst.mockResolvedValue({ id: 'staff-1' });
  h.materialize.mockResolvedValue(STATS);
  h.record.mockResolvedValue({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Verdrahtung des DI-Kerns', () => {
  it('übergibt prismaOwner als db und die korrekten Params (horizonDays 90)', async () => {
    const result = await run();

    expect(h.materialize).toHaveBeenCalledTimes(1);
    const [deps, params] = h.materialize.mock.calls[0]!;
    expect(deps.db).toBe(h.prismaOwner);
    expect(params).toEqual({ tenantId: TENANT, systemStaffId: 'staff-1', horizonDays: 90 });
    expect(result).toEqual({ created: 2, requests: 1, overdue: 3 });
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
    expect(result).toEqual({ created: 0, requests: 0, overdue: 0 });
  });
});

describe('Multi-Tenant', () => {
  it('summiert die Stats über alle Tenants', async () => {
    h.prismaOwner.tenant.findMany.mockResolvedValue([{ id: 'tenant-a' }, { id: 'tenant-b' }]);
    h.materialize
      .mockResolvedValueOnce({ deadlinesCreated: 2, requestsCreated: 1, markedOverdue: 0 })
      .mockResolvedValueOnce({ deadlinesCreated: 3, requestsCreated: 0, markedOverdue: 4 });

    const result = await run({});

    expect(h.materialize).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ created: 5, requests: 1, overdue: 4 });
  });
});
