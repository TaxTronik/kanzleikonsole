// =============================================================================
// Unit-Tests: dsgvo-retention-Worker (Fristenlöschung mit Audit-Nachweis).
//
// bullmq via mocks/bullmq.ts, Prisma/Tenant-Context/Evidence per vi.mock.
// Abgedeckt:
//   - Löschungen laufen PRO TENANT (tenantId in jeder where-Klausel)
//   - Cutoffs leap-year-korrekt über setFullYear (1/3/2/6/10 Jahre)
//   - Audit-Nachweis: EIN 'dsgvo.retention.run'-Event pro Lauf+Tenant in der
//     withWorkerTenantContext-Tx (Zähler je Datenklasse + Cutoffs)
//   - Idempotenz: Lauf ohne Treffer schreibt KEIN Event (kein Chain-Rauschen)
//   - Request-Purge nullt lose Rückverweise (tax_deadline/form_submission)
//     vor dem deleteMany in derselben Batch-Tx
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => {
  const prismaOwner = {
    tenant: { findMany: vi.fn() },
    notification: { deleteMany: vi.fn() },
    phoneNote: { deleteMany: vi.fn() },
    clientContact: { updateMany: vi.fn() },
    request: { findMany: vi.fn(), deleteMany: vi.fn() },
    taxDeadline: { updateMany: vi.fn() },
    formSubmission: { updateMany: vi.fn() },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const tx = {};
  const withWorkerTenantContext = vi.fn(
    async (_tenantId: string, fn: (t: unknown) => Promise<unknown>) => fn(tx),
  );
  const record = vi.fn();
  return { prismaOwner, tx, withWorkerTenantContext, record };
});

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../prisma-owner', () => ({ prismaOwner: h.prismaOwner }));
vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../tenant-context', () => ({ withWorkerTenantContext: h.withWorkerTenantContext }));
vi.mock('@taxtronik/evidence', () => ({
  EvidenceService: class {
    record = h.record;
  },
  LocalTimestampAdapter: class {},
}));

import { processors } from './mocks/bullmq';
import '../dsgvo-retention';

const FIXED_NOW = new Date('2026-06-09T10:00:00.000Z');
const TENANT = 'tenant-1';

function cutoff(years: number): Date {
  const d = new Date(FIXED_NOW);
  d.setFullYear(d.getFullYear() - years);
  return d;
}

/**
 * Jahresende-Anker für aufbewahrungspflichtige Requests (§ 147 Abs. 4 AO):
 * gelöscht wird erst ab dem 1.1. des Jahres (aktuelles Jahr − years), NICHT
 * rollierend ab Erstellungsdatum. FIXED_NOW 2026 → reqCutoff(10) = 2016-01-01.
 */
function reqCutoff(years: number): Date {
  return new Date(Date.UTC(FIXED_NOW.getUTCFullYear() - years, 0, 1));
}

function run(data: { tenantId?: string } = { tenantId: TENANT }): Promise<unknown> {
  return processors.get('dsgvo-retention')!({ data });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  vi.resetAllMocks();
  h.withWorkerTenantContext.mockImplementation(
    async (_tenantId: string, fn: (t: unknown) => Promise<unknown>) => fn(h.tx),
  );
  h.prismaOwner.tenant.findMany.mockResolvedValue([{ id: TENANT }]);
  h.prismaOwner.notification.deleteMany.mockResolvedValue({ count: 0 });
  h.prismaOwner.phoneNote.deleteMany.mockResolvedValue({ count: 0 });
  h.prismaOwner.clientContact.updateMany.mockResolvedValue({ count: 0 });
  h.prismaOwner.request.findMany.mockResolvedValue([]);
  h.prismaOwner.request.deleteMany.mockResolvedValue({ count: 0 });
  h.prismaOwner.taxDeadline.updateMany.mockResolvedValue({ count: 0 });
  h.prismaOwner.formSubmission.updateMany.mockResolvedValue({ count: 0 });
  h.prismaOwner.$transaction.mockImplementation(async (ops: Promise<unknown>[]) =>
    Promise.all(ops),
  );
  h.record.mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Löschungen pro Tenant + Cutoffs', () => {
  it('filtert jede Datenklasse auf tenantId + leap-year-korrekten Cutoff', async () => {
    await run();

    expect(h.prismaOwner.notification.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT, createdAt: { lt: cutoff(1) } },
    });
    expect(h.prismaOwner.phoneNote.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT, createdAt: { lt: cutoff(3) } },
    });
    expect(h.prismaOwner.clientContact.updateMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT, lastLoginAt: { lt: cutoff(2) } },
      data: { lastLoginAt: null },
    });
    // Request-Purge: 6 Jahre ohne GoBD-Bezug, 10 Jahre mit — beide tenant-scoped.
    const requestWheres = h.prismaOwner.request.findMany.mock.calls.map(
      (c) => (c[0] as { where: Record<string, unknown> }).where,
    );
    expect(requestWheres).toHaveLength(2);
    // Jahresende-Anker (§ 147 Abs. 4 AO), nicht rollierend ab createdAt.
    expect(requestWheres[0]).toMatchObject({ tenantId: TENANT, createdAt: { lt: reqCutoff(6) } });
    expect(requestWheres[0]).toHaveProperty('NOT');
    expect(requestWheres[1]).toMatchObject({ tenantId: TENANT, createdAt: { lt: reqCutoff(10) } });
  });

  it('Request-Cutoff ist auf den 1. Januar verankert (nicht ab Erstellungsdatum)', async () => {
    await run();
    const requestWheres = h.prismaOwner.request.findMany.mock.calls.map(
      (c) => (c[0] as { where: { createdAt: { lt: Date } } }).where,
    );
    // Der GoBD-Cutoff (10 J.) muss der 1.1. sein — ein GoBD-Request vom
    // 15.03.2016 wäre bis 31.12.2026 aufzubewahren und darf 2026 NICHT gelöscht
    // werden. Rollierend (2016-06-09) hätte er ihn erfasst.
    const gobdCutoff = requestWheres[1]!.createdAt.lt;
    expect(gobdCutoff.getUTCMonth()).toBe(0);
    expect(gobdCutoff.getUTCDate()).toBe(1);
    expect(gobdCutoff.getTime()).toBe(Date.UTC(2016, 0, 1));
    expect(new Date(Date.UTC(2016, 2, 15)).getTime()).toBeGreaterThanOrEqual(gobdCutoff.getTime());
  });

  it('ohne job.data.tenantId läuft jeder Tenant einzeln', async () => {
    h.prismaOwner.tenant.findMany.mockResolvedValue([{ id: 't-a' }, { id: 't-b' }]);

    await run({});

    const tenants = h.prismaOwner.notification.deleteMany.mock.calls.map(
      (c) => (c[0] as { where: { tenantId: string } }).where.tenantId,
    );
    expect(tenants).toEqual(['t-a', 't-b']);
  });
});

describe('Audit-Nachweis dsgvo.retention.run', () => {
  it('schreibt EIN zusammenfassendes Event (Zähler + Cutoffs) in der Tenant-Tx', async () => {
    h.prismaOwner.notification.deleteMany.mockResolvedValue({ count: 3 });
    h.prismaOwner.phoneNote.deleteMany.mockResolvedValue({ count: 2 });
    h.prismaOwner.clientContact.updateMany.mockResolvedValue({ count: 1 });

    await run();

    expect(h.withWorkerTenantContext).toHaveBeenCalledTimes(1);
    expect(h.withWorkerTenantContext.mock.calls[0]![0]).toBe(TENANT);
    expect(h.record).toHaveBeenCalledTimes(1);
    // Record läuft auf DEMSELBEN Tx-Client wie der Tenant-Context
    expect(h.record.mock.calls[0]![0]).toBe(h.tx);
    expect(h.record.mock.calls[0]![1]).toEqual({
      tenantId: TENANT,
      actorType: 'SYSTEM',
      actorId: null,
      action: 'dsgvo.retention.run',
      resourceType: 'tenant',
      resourceId: TENANT,
      after: {
        notificationsDeleted: 3,
        phoneNotesDeleted: 2,
        lastLoginCleared: 1,
        requestsDeletedNonGobd: 0,
        requestsDeletedGobd: 0,
        notifCutoff: cutoff(1).toISOString(),
        phoneCutoff: cutoff(3).toISOString(),
        loginCutoff: cutoff(2).toISOString(),
        requestCutoff: reqCutoff(6).toISOString(),
        requestGobdCutoff: reqCutoff(10).toISOString(),
      },
    });
  });

  it('idempotent: Lauf ohne Treffer schreibt KEIN Event', async () => {
    await run();

    expect(h.withWorkerTenantContext).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
  });
});

describe('Request-Purge', () => {
  it('nullt lose Rückverweise + löscht Requests in derselben Batch-Tx', async () => {
    h.prismaOwner.request.findMany
      .mockResolvedValueOnce([{ id: 'req-1' }, { id: 'req-2' }])
      .mockResolvedValue([]);

    await run();

    expect(h.prismaOwner.$transaction).toHaveBeenCalledTimes(1);
    expect(h.prismaOwner.taxDeadline.updateMany).toHaveBeenCalledWith({
      where: { requestId: { in: ['req-1', 'req-2'] } },
      data: { requestId: null },
    });
    expect(h.prismaOwner.formSubmission.updateMany).toHaveBeenCalledWith({
      where: { requestId: { in: ['req-1', 'req-2'] } },
      data: { requestId: null },
    });
    expect(h.prismaOwner.request.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['req-1', 'req-2'] } },
    });
    // 2 gelöschte Requests → Audit-Event mit dem Zähler
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.record.mock.calls[0]![1]).toMatchObject({
      action: 'dsgvo.retention.run',
      after: expect.objectContaining({ requestsDeletedNonGobd: 2 }),
    });
  });
});
