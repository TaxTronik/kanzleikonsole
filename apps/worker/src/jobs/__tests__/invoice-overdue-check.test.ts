// Fachkatalog: INV-DUE-OVERDUE-001, ACCESS-NOTIFICATION-RECIPIENT-001
// =============================================================================
// Unit-Tests: invoice-overdue-check-Worker (SENT → OVERDUE + Notification).
//
// bullmq via mocks/bullmq.ts, Prisma/Tenant-Context/Evidence per vi.mock;
// '@prisma/client' wird mit einer Fake-PrismaClientKnownRequestError-Klasse
// gemockt, damit der instanceof-Check im P2002-Catch ohne generierten Client
// funktioniert. Abgedeckt:
//   - U-1/RF-8: Status-Update, Audit-Record 'invoice.overdue' und Notification
//     laufen in EINER Tenant-Context-Tx
//   - R-11: die Notification läuft über notify() (Upsert mit Sperre und
//     Sanitizer, siehe packages/db notification-batch); nur Neuanlagen zählen
//   - P2002 (paralleler Trigger) wird geschluckt, andere Fehler propagieren
//   - A6: Empfänger über den gemeinsamen Filter (notification-recipients.ts, echt):
//     der Ersteller nur aktiv und zugriffsberechtigt, sonst aktive, berechtigte
//     ADMIN/PARTNER; offene Meldungen werden je Empfänger aktualisiert
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => {
  class PrismaClientKnownRequestError extends Error {
    code: string;
    constructor(message: string, opts: { code: string }) {
      super(message);
      this.code = opts.code;
    }
  }
  const prismaOwner = {
    tenant: { findMany: vi.fn() },
    invoice: { findMany: vi.fn() },
  };
  const tx = {
    invoice: { updateMany: vi.fn() },
    // ADMIN/PARTNER-Fallback des gemeinsamen Empfängerfilters
    staffUser: { findMany: vi.fn() },
  };
  // Inaktive, fehlende oder für den Mandanten nicht berechtigte Mitarbeiter.
  const withoutAccess = new Set<string>();
  const filterStaffAccessClientTx = vi.fn(
    async (_tx: unknown, _tenantId: string, ids: readonly string[], _clientId: string) =>
      new Set(ids.filter((id) => !withoutAccess.has(id))),
  );
  const notify = vi.fn();
  const withWorkerTenantContext = vi.fn(
    async (_tenantId: string, fn: (t: unknown) => Promise<unknown>) => fn(tx),
  );
  const record = vi.fn();
  return {
    PrismaClientKnownRequestError,
    prismaOwner,
    tx,
    withoutAccess,
    filterStaffAccessClientTx,
    withWorkerTenantContext,
    record,
    notify,
  };
});

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../prisma-owner', () => ({ prismaOwner: h.prismaOwner }));
vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../tenant-context', () => ({ withWorkerTenantContext: h.withWorkerTenantContext }));
vi.mock('../../notify', () => ({ notify: h.notify }));
vi.mock('@taxtronik/db/staff-client-access', () => ({
  filterStaffAccessClientTx: h.filterStaffAccessClientTx,
}));
vi.mock('@prisma/client', () => ({
  Prisma: { PrismaClientKnownRequestError: h.PrismaClientKnownRequestError },
}));
vi.mock('@taxtronik/evidence', () => ({
  EvidenceService: class {
    record = h.record;
  },
  LocalTimestampAdapter: class {},
}));

import { processors } from './mocks/bullmq';
import { log } from '../../logger';
import '../invoice-overdue-check';

const FIXED_NOW = new Date('2026-06-09T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
// Berlin-Tagesbeginn heute (CEST) als UTC-Mitternacht — überfällig erst ab
// dem Folgetag der Fälligkeit (§ 271 BGB).
const TODAY_MIDNIGHT = new Date(Date.UTC(2026, 5, 9));
const TENANT = 'tenant-1';

interface InvoiceResult {
  updated: number;
  notified: number;
}

function run(): Promise<InvoiceResult> {
  return processors.get('invoice-overdue-check')!({
    data: { tenantId: TENANT },
  }) as Promise<InvoiceResult>;
}

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    number: 'RE-2026-0001',
    dueDate: new Date(FIXED_NOW.getTime() - 3 * DAY),
    clientId: 'client-1',
    createdByStaff: 'staff-1',
    totalAmount: { toString: () => '119.00' },
    client: { name: 'Muster GmbH' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  vi.resetAllMocks();
  h.withWorkerTenantContext.mockImplementation(
    async (_tenantId: string, fn: (t: unknown) => Promise<unknown>) => fn(h.tx),
  );
  h.withoutAccess.clear();
  h.filterStaffAccessClientTx.mockImplementation(
    async (_tx: unknown, _tenantId: string, ids: readonly string[], _clientId: string) =>
      new Set(ids.filter((id) => !h.withoutAccess.has(id))),
  );
  h.tx.staffUser.findMany.mockResolvedValue([{ id: 'admin-1' }, { id: 'partner-1' }]);
  h.prismaOwner.tenant.findMany.mockResolvedValue([{ id: TENANT }]);
  h.prismaOwner.invoice.findMany.mockResolvedValue([]);
  h.tx.invoice.updateMany.mockResolvedValue({ count: 1 });
  h.notify.mockResolvedValue({ created: 1, updated: 0 });
  h.record.mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('U-1/RF-8: Statuswechsel + Audit + Notification in einer Tx', () => {
  it('setzt OVERDUE, schreibt invoice.overdue und Notification auf demselben Tx-Client', async () => {
    h.prismaOwner.invoice.findMany.mockResolvedValue([invoice()]);

    const result = await run();

    // Nur SENT-Rechnungen, deren Fälligkeit VOR dem heutigen Tagesbeginn liegt
    // (Zahlung am Fälligkeitstag ist rechtzeitig → nicht überfällig).
    expect(h.prismaOwner.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: TENANT,
          status: 'SENT',
          dueDate: { lt: TODAY_MIDNIGHT },
          stornoOfId: null,
        },
      }),
    );
    expect(h.withWorkerTenantContext).toHaveBeenCalledTimes(1);
    expect(h.withWorkerTenantContext.mock.calls[0]![0]).toBe(TENANT);
    // Status-Recheck IN der Tx: nur SENT → OVERDUE (sonst würfe der Trigger).
    expect(h.tx.invoice.updateMany).toHaveBeenCalledWith({
      where: { id: 'inv-1', status: 'SENT' },
      data: { status: 'OVERDUE' },
    });
    // Audit-Record läuft auf DEMSELBEN Tx-Client wie das Update
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.record.mock.calls[0]![0]).toBe(h.tx);
    expect(h.record.mock.calls[0]![1]).toEqual({
      tenantId: TENANT,
      actorType: 'SYSTEM',
      actorId: null,
      action: 'invoice.overdue',
      resourceType: 'invoice',
      resourceId: 'inv-1',
      before: { status: 'SENT' },
      after: { status: 'OVERDUE', daysOverdue: 3 },
    });
    expect(h.notify).toHaveBeenCalledWith(h.tx, [
      {
        tenantId: TENANT,
        staffId: 'staff-1',
        kind: 'INVOICE_OVERDUE',
        title: 'Rechnung RE-2026-0001 überfällig (3 Tage)',
        body: 'Mandant: Muster GmbH · Brutto: 119.00 €',
        href: '/staff/invoices/inv-1',
        resourceType: 'invoice',
        resourceId: 'inv-1',
      },
    ]);
    // Aktiver, berechtigter Ersteller: kein ADMIN/PARTNER-Fallback.
    expect(h.filterStaffAccessClientTx).toHaveBeenCalledWith(h.tx, TENANT, ['staff-1'], 'client-1');
    expect(h.tx.staffUser.findMany).not.toHaveBeenCalled();
    expect(result).toEqual({ updated: 1, notified: 1 });
  });

  it('Singular bei genau 1 Tag Verzug', async () => {
    h.prismaOwner.invoice.findMany.mockResolvedValue([
      invoice({ dueDate: new Date(FIXED_NOW.getTime() - DAY) }),
    ]);

    await run();

    expect(h.notify).toHaveBeenCalledWith(h.tx, [
      expect.objectContaining({ title: 'Rechnung RE-2026-0001 überfällig (1 Tag)' }),
    ]);
  });
});

describe('Idempotenz der Notification', () => {
  it('ungelesene INVOICE_OVERDUE-Notification wird aktualisiert, nicht neu gezählt', async () => {
    h.prismaOwner.invoice.findMany.mockResolvedValue([invoice()]);
    // notify() aktualisiert die offene Notification desselben Schlüssels.
    h.notify.mockResolvedValue({ created: 0, updated: 1 });

    const result = await run();

    expect(h.notify).toHaveBeenCalledTimes(1);
    // updated zählt, notified nicht — es gab schon eine offene Notification
    expect(result).toEqual({ updated: 1, notified: 0 });
  });
});

describe('Fehlerbehandlung', () => {
  it('P2002 (paralleler Notification-Insert) wird geschluckt, die nächste Rechnung läuft weiter', async () => {
    h.prismaOwner.invoice.findMany.mockResolvedValue([
      invoice(),
      invoice({ id: 'inv-2', number: 'RE-2026-0002' }),
    ]);
    // Reale P2002-Quelle ist der Notification-Idempotenz-Index bei create —
    // updateMany(status=SENT) kann nach dem Recheck-Fix kein P2002 mehr werfen
    // (paralleler Treffer ergibt count=0). Den Catch also an seinem echten
    // Auslöser testen.
    h.notify.mockRejectedValueOnce(
      new h.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002' }),
    );

    const result = await run();

    // inv-1: Insert kollidierte (geschluckt, nicht gezählt), inv-2 normal.
    expect(result).toEqual({ updated: 1, notified: 1 });
    expect(h.notify).toHaveBeenCalledTimes(2);
  });

  it('andere Fehler propagieren (Job schlägt fehl)', async () => {
    h.prismaOwner.invoice.findMany.mockResolvedValue([invoice()]);
    h.tx.invoice.updateMany.mockRejectedValueOnce(new Error('connection lost'));

    await expect(run()).rejects.toThrow('connection lost');
  });

  it('zwischenzeitlich bezahlt/storniert (count 0) → übersprungen, kein Audit/Notification', async () => {
    // Review-Fix: zwischen findMany und Update kann die Rechnung den Status
    // verlassen haben. updateMany trifft dann nichts (count 0) — die Rechnung
    // wird übersprungen statt den Trigger (restrict_violation) auszulösen.
    h.prismaOwner.invoice.findMany.mockResolvedValue([invoice()]);
    h.tx.invoice.updateMany.mockResolvedValueOnce({ count: 0 });

    const result = await run();

    expect(result).toEqual({ updated: 0, notified: 0 });
    expect(h.record).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });
});

// INV-DUE-OVERDUE-001 — Produktentscheidung A6 (2026-10-07): Fallback auf aktive
// ADMIN/PARTNER wie bei GwG- und Vollmachtswarnungen.
describe('A6: Empfänger bei inaktivem oder fehlendem Ersteller', () => {
  function recipientsOf(call: number): string[] {
    const inputs = h.notify.mock.calls[call]![1] as Array<{ staffId: string }>;
    return inputs.map((input) => input.staffId);
  }

  it.each([
    ['inaktiv', 'staff-1'],
    ['nicht mehr vorhanden', 'staff-deleted'],
  ])('Ersteller %s: aktive ADMIN/PARTNER erhalten die Meldung', async (_name, creator) => {
    h.withoutAccess.add(creator);
    h.prismaOwner.invoice.findMany.mockResolvedValue([invoice({ createdByStaff: creator })]);
    h.notify.mockResolvedValue({ created: 2, updated: 0 });

    const result = await run();

    expect(h.tx.staffUser.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT,
        active: true,
        roles: { some: { role: { in: ['ADMIN', 'PARTNER'] } } },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    expect(recipientsOf(0)).toEqual(['admin-1', 'partner-1']);
    expect(h.notify).toHaveBeenCalledWith(h.tx, [
      expect.objectContaining({
        staffId: 'admin-1',
        kind: 'INVOICE_OVERDUE',
        resourceType: 'invoice',
        resourceId: 'inv-1',
      }),
      expect.objectContaining({
        staffId: 'partner-1',
        kind: 'INVOICE_OVERDUE',
        resourceType: 'invoice',
        resourceId: 'inv-1',
      }),
    ]);
    expect(result).toEqual({ updated: 1, notified: 2 });
  });

  it('ohne aktuellen Mandantenzugriff des Erstellers gilt derselbe Fallback, nur berechtigte ADMIN/PARTNER', async () => {
    h.withoutAccess.add('staff-1');
    h.withoutAccess.add('admin-1');
    h.prismaOwner.invoice.findMany.mockResolvedValue([invoice()]);

    await run();

    expect(recipientsOf(0)).toEqual(['partner-1']);
  });

  it('aktualisiert offene Meldungen je Empfänger statt sie zu duplizieren', async () => {
    h.withoutAccess.add('staff-1');
    h.prismaOwner.invoice.findMany.mockResolvedValue([invoice()]);
    h.notify.mockResolvedValue({ created: 0, updated: 2 });

    const result = await run();

    // Standard-Dedupe von notify(): ungelesene Meldung desselben Schlüssels
    // (Tenant, Empfänger, Art, Rechnung) wird aktualisiert.
    expect(h.notify.mock.calls[0]).toHaveLength(2);
    expect(result).toEqual({ updated: 1, notified: 0 });
  });

  it('ohne berechtigten Empfänger: Status und Audit, keine Meldung, Warnung im Log', async () => {
    h.withoutAccess.add('staff-1');
    h.tx.staffUser.findMany.mockResolvedValue([]);
    h.prismaOwner.invoice.findMany.mockResolvedValue([invoice()]);
    h.notify.mockResolvedValue({ created: 0, updated: 0 });

    const result = await run();

    expect(h.tx.invoice.updateMany).toHaveBeenCalledTimes(1);
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledWith(h.tx, []);
    expect(log.warn).toHaveBeenCalledWith(
      { tenantId: TENANT, invoiceId: 'inv-1' },
      'invoice-overdue: no active recipient',
    );
    expect(result).toEqual({ updated: 1, notified: 0 });
  });
});
