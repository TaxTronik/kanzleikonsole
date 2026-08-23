// =============================================================================
// Unit-Tests: dsgvo-retention-Worker (Fristenlöschung mit Audit-Nachweis).
//
// bullmq via mocks/bullmq.ts, Prisma/Tenant-Context/Evidence per vi.mock.
// Abgedeckt:
//   - Löschungen laufen PRO TENANT (tenantId in jeder where-Klausel)
//   - Cutoffs leap-year-korrekt über setFullYear (1/3/2/6/8/10 Jahre)
//   - Audit-Nachweis: EIN 'dsgvo.retention.run'-Event pro Lauf+Tenant in der
//     withWorkerTenantContext-Tx (Zähler je Datenklasse + Cutoffs)
//   - Idempotenz: Lauf ohne Treffer schreibt KEIN Event (kein Chain-Rauschen)
//   - Request-Purge nullt lose Rückverweise (tax_deadline/form_submission)
//     vor dem deleteMany in derselben Batch-Tx und revalidiert unter Row-Lock
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => {
  const tenant = { findMany: vi.fn() };
  const notification = { deleteMany: vi.fn() };
  const phoneNote = { deleteMany: vi.fn() };
  const clientContact = { updateMany: vi.fn() };
  const request = { findMany: vi.fn(), deleteMany: vi.fn() };
  const taxDeadline = { updateMany: vi.fn() };
  const formSubmission = { updateMany: vi.fn() };
  const retentionTx = {
    $queryRaw: vi.fn(),
    request,
    taxDeadline,
    formSubmission,
  };
  const transaction = vi.fn(async (arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: typeof retentionTx) => Promise<unknown>)(retentionTx);
    }
    return Promise.all(arg as Promise<unknown>[]);
  });
  const prismaOwner = {
    tenant,
    notification,
    phoneNote,
    clientContact,
    request,
    taxDeadline,
    formSubmission,
    $transaction: transaction,
  };
  const tx = {};
  const withWorkerTenantContext = vi.fn(
    async (_tenantId: string, fn: (t: unknown) => Promise<unknown>) => fn(tx),
  );
  const record = vi.fn();
  return { prismaOwner, retentionTx, tx, withWorkerTenantContext, record };
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
  h.retentionTx.$queryRaw.mockResolvedValue([]);
  h.prismaOwner.taxDeadline.updateMany.mockResolvedValue({ count: 0 });
  h.prismaOwner.formSubmission.updateMany.mockResolvedValue({ count: 0 });
  h.prismaOwner.$transaction.mockImplementation(async (arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: typeof h.retentionTx) => Promise<unknown>)(h.retentionTx);
    }
    return Promise.all(arg as Promise<unknown>[]);
  });
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
    // Request-Purge: Grund-/GoBD-Klassen 6, 8 und 10 Jahre — alle tenant-scoped.
    const requestWheres = h.prismaOwner.request.findMany.mock.calls.map(
      (c) => (c[0] as { where: Record<string, unknown> }).where,
    );
    expect(requestWheres).toHaveLength(3);
    // Jahresende-Anker (§ 147 Abs. 4 AO), nicht rollierend ab createdAt.
    expect(requestWheres[0]).toMatchObject({
      tenantId: TENANT,
      AND: [
        {
          status: { in: ['CLOSED', 'CANCELLED'] },
          OR: [
            { closedAt: { lt: reqCutoff(6) } },
            { closedAt: null, updatedAt: { lt: reqCutoff(6) } },
          ],
          responses: { none: { createdAt: { gte: reqCutoff(6) } } },
        },
        { NOT: expect.anything() },
      ],
    });
    expect(requestWheres[1]).toMatchObject({
      tenantId: TENANT,
      AND: [
        {
          status: { in: ['CLOSED', 'CANCELLED'] },
          OR: [
            { closedAt: { lt: reqCutoff(8) } },
            { closedAt: null, updatedAt: { lt: reqCutoff(8) } },
          ],
          responses: { none: { createdAt: { gte: reqCutoff(8) } } },
        },
        {
          responses: {
            some: {
              document: {
                OR: [
                  { documentType: { tier: 'GOBD', retentionYears: 8 } },
                  { documentTypeId: null, classification: 'GOBD_INVOICE' },
                ],
              },
            },
          },
          NOT: expect.anything(),
        },
      ],
    });
    expect(requestWheres[2]).toMatchObject({
      tenantId: TENANT,
      AND: [
        {
          status: { in: ['CLOSED', 'CANCELLED'] },
          OR: [
            { closedAt: { lt: reqCutoff(10) } },
            { closedAt: null, updatedAt: { lt: reqCutoff(10) } },
          ],
          responses: { none: { createdAt: { gte: reqCutoff(10) } } },
        },
        {
          responses: {
            some: {
              document: {
                OR: expect.arrayContaining([
                  { documentTypeId: null, classification: { in: ['GOBD_CONTRACT', 'GOBD_TAX'] } },
                ]),
              },
            },
          },
        },
      ],
    });
  });

  it('Request-Cutoff ist auf den 1. Januar verankert und verlangt terminalen Abschluss', async () => {
    await run();
    const requestWheres = h.prismaOwner.request.findMany.mock.calls.map(
      (c) =>
        (
          c[0] as {
            where: { AND: Array<{ status?: unknown; OR?: Array<{ closedAt?: { lt: Date } }> }> };
          }
        ).where,
    );
    // Der GoBD-Cutoff (10 J.) muss der 1.1. sein — ein GoBD-Request vom
    // 15.03.2016 wäre bis 31.12.2026 aufzubewahren und darf 2026 NICHT gelöscht
    // werden. Rollierend (2016-06-09) hätte er ihn erfasst.
    const tenYearWindow = requestWheres[2]!.AND[0]!;
    expect(tenYearWindow.status).toEqual({ in: ['CLOSED', 'CANCELLED'] });
    const gobdCutoff = tenYearWindow.OR![0]!.closedAt!.lt;
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
        requestsDeletedSixYear: 0,
        requestsDeletedEightYear: 0,
        requestsDeletedTenYear: 0,
        notifCutoff: cutoff(1).toISOString(),
        phoneCutoff: cutoff(3).toISOString(),
        loginCutoff: cutoff(2).toISOString(),
        requestCutoff: reqCutoff(6).toISOString(),
        requestGobdInvoiceCutoff: reqCutoff(8).toISOString(),
        requestGobdLongCutoff: reqCutoff(10).toISOString(),
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
  it('nullt Deadline-Verweise, setzt Formular-Tombstones und löscht im selben Batch', async () => {
    h.prismaOwner.request.findMany
      .mockResolvedValueOnce([{ id: 'req-1' }, { id: 'req-2' }])
      .mockResolvedValueOnce([{ id: 'req-1' }, { id: 'req-2' }])
      .mockResolvedValue([]);
    h.prismaOwner.request.deleteMany.mockResolvedValue({ count: 2 });

    await run();

    expect(h.prismaOwner.$transaction).toHaveBeenCalledTimes(1);
    expect(h.retentionTx.$queryRaw).toHaveBeenCalledTimes(3);
    expect(h.prismaOwner.taxDeadline.updateMany).toHaveBeenCalledWith({
      where: { requestId: { in: ['req-1', 'req-2'] } },
      data: { requestId: null },
    });
    expect(h.prismaOwner.formSubmission.updateMany).not.toHaveBeenCalled();
    const submissionLockSql = h.retentionTx.$queryRaw.mock.calls[0]?.[0] as { sql: string };
    expect(submissionLockSql.sql).toContain('ORDER BY submission."id"');
    expect(submissionLockSql.sql).toContain('FOR UPDATE');
    const tombstoneSql = h.retentionTx.$queryRaw.mock.calls[2]?.[0] as { sql: string };
    expect(tombstoneSql.sql).toContain('purged_form_links');
    expect(tombstoneSql.sql).toContain('submission."request_id" IS NULL');
    expect(h.prismaOwner.request.deleteMany).toHaveBeenCalledWith({
      where: {
        AND: [expect.anything(), { id: { in: ['req-1', 'req-2'] } }],
      },
    });
    // 2 gelöschte Requests → Audit-Event mit dem Zähler
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.record.mock.calls[0]![1]).toMatchObject({
      action: 'dsgvo.retention.run',
      after: expect.objectContaining({ requestsDeletedSixYear: 2 }),
    });
  });

  it('löscht fail-closed nichts, wenn der Row-Lock-Recheck den Request ausschließt', async () => {
    h.prismaOwner.request.findMany
      .mockResolvedValueOnce([{ id: 'req-1' }])
      // Recheck innerhalb der gelockten Transaktion: z. B. inzwischen neue
      // Antwort oder Status wieder IN_PROGRESS.
      .mockResolvedValueOnce([])
      .mockResolvedValue([]);

    await run();

    expect(h.retentionTx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(h.prismaOwner.taxDeadline.updateMany).not.toHaveBeenCalled();
    expect(h.prismaOwner.formSubmission.updateMany).not.toHaveBeenCalled();
    expect(h.prismaOwner.request.deleteMany).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
  });
});
