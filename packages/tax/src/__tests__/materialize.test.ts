// =============================================================================
// Unit-Tests: materializeTenantTaxDeadlines (gemeinsamer Kern Web/Worker).
//
// DB + Evidence kommen per Dependency-Injection — die Tests injizieren einen
// Fake-Client (vi.fn pro Query) und einen separaten Fake-Tx für runAtomic,
// damit prüfbar ist, dass Request + Deadline-Update + Audit-Eintrag wirklich
// in DERSELBEN Transaktion laufen. Abgedeckt:
//   - Upsert: EIN createMany(skipDuplicates) über den Unique-Key (P-4 —
//     vorher findUnique+create pro Kandidat), Duplikate zählen nicht
//   - Mandant ohne allowActive (GwG) wird übersprungen
//   - Reminder-Pfad: Request + REMINDED + Evidence atomar, Re-Check-Race,
//     SQL-Vorfilter dueDate ≤ now + max(reminderDaysBefore)
//   - Reminder-Fenster (reminderDaysBefore) noch nicht erreicht → kein Request
//   - OVERDUE erst NACH Ende des Fälligkeitstags (§ 108 (1) AO)
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import { materializeTenantTaxDeadlines, type MaterializeDeps } from '../index';

type Db = MaterializeDeps['db'];

const TENANT = 'tenant-1';
const STAFF = 'staff-system-1';
// Dienstag, kein Feiertag — Folgetag (10.06.2026, Mittwoch) ebenfalls Werktag.
const NOW = new Date('2026-06-09T10:00:00.000Z');

interface HarnessOptions {
  configs?: unknown[];
  upcoming?: unknown[];
  createdCount?: number;
  overdueCount?: number;
}

function makeHarness(opts: HarnessOptions = {}) {
  const db = {
    tenantSetting: { findUnique: vi.fn().mockResolvedValue(null) },
    taxScheduleConfig: { findMany: vi.fn().mockResolvedValue(opts.configs ?? []) },
    taxDeadline: {
      createMany: vi.fn().mockResolvedValue({ count: opts.createdCount ?? 0 }),
      findMany: vi.fn().mockResolvedValue(opts.upcoming ?? []),
      updateMany: vi.fn().mockResolvedValue({ count: opts.overdueCount ?? 0 }),
    },
  };
  // Separater Tx-Fake: so ist nachweisbar, dass der atomare Block NICHT auf
  // dem äußeren db-Client läuft, sondern auf dem von runAtomic gereichten Tx.
  const tx = {
    taxDeadline: {
      findUnique: vi.fn().mockResolvedValue({ status: 'PLANNED', requestId: null }),
      update: vi.fn().mockResolvedValue({}),
    },
    request: { create: vi.fn().mockResolvedValue({ id: 'req-1' }) },
  };
  const recordEvidence = vi.fn().mockResolvedValue(undefined);
  const runAtomic = vi.fn(async (fn: (t: Db) => Promise<unknown>) => fn(tx as unknown as Db));
  const deps: MaterializeDeps = {
    db: db as unknown as Db,
    runAtomic: runAtomic as MaterializeDeps['runAtomic'],
    recordEvidence,
  };
  return { db, tx, deps, recordEvidence, runAtomic };
}

function ustaMonthlyConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cfg-1',
    clientId: 'client-1',
    kind: 'USTA_MONATLICH',
    hasDauerfrist: false,
    advised: false,
    reminderDaysBefore: 10,
    client: { id: 'client-1', allowActive: true },
    ...overrides,
  };
}

describe('Upsert — Termine aus aktiven Configs', () => {
  it('legt einen neuen Termin im Horizont an (USt-VA Mai → fällig 10.06.)', async () => {
    const { db, deps } = makeHarness({ configs: [ustaMonthlyConfig()], createdCount: 1 });
    const stats = await materializeTenantTaxDeadlines(deps, {
      tenantId: TENANT,
      systemStaffId: STAFF,
      horizonDays: 10,
      now: NOW,
    });

    // Bundesland-Lookup für die Werktagsverschiebung
    expect(db.tenantSetting.findUnique).toHaveBeenCalledWith({
      where: { tenantId_key: { tenantId: TENANT, key: 'tax_region' } },
    });
    // P-4: EIN createMany über alle Kandidaten — Idempotenz via skipDuplicates
    // (ON CONFLICT DO NOTHING auf dem Unique-Key tenant+client+kind+period).
    expect(db.taxDeadline.createMany).toHaveBeenCalledTimes(1);
    expect(db.taxDeadline.createMany).toHaveBeenCalledWith({
      data: [
        {
          tenantId: TENANT,
          clientId: 'client-1',
          configId: 'cfg-1',
          kind: 'USTA_MONATLICH',
          period: '2026-05',
          dueDate: new Date(Date.UTC(2026, 5, 10)),
        },
      ],
      skipDuplicates: true,
    });
    expect(stats.configsScanned).toBe(1);
    expect(stats.deadlinesCreated).toBe(1);
  });

  it('ist idempotent: vorhandener Termin (Unique-Key) zählt nicht als neu angelegt', async () => {
    // skipDuplicates → DB meldet count: 0, wenn alle Kandidaten schon existieren
    const { db, deps } = makeHarness({ configs: [ustaMonthlyConfig()], createdCount: 0 });

    const stats = await materializeTenantTaxDeadlines(deps, {
      tenantId: TENANT,
      systemStaffId: STAFF,
      horizonDays: 10,
      now: NOW,
    });

    expect(db.taxDeadline.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    expect(stats.deadlinesCreated).toBe(0);
  });

  it('überspringt Mandanten ohne allowActive (GwG-Sperre)', async () => {
    const cfg = ustaMonthlyConfig({ client: { id: 'client-1', allowActive: false } });
    const { db, deps } = makeHarness({ configs: [cfg] });

    const stats = await materializeTenantTaxDeadlines(deps, {
      tenantId: TENANT,
      systemStaffId: STAFF,
      horizonDays: 10,
      now: NOW,
    });

    expect(db.taxDeadline.createMany).not.toHaveBeenCalled();
    expect(stats.configsScanned).toBe(1);
    expect(stats.deadlinesCreated).toBe(0);
  });
});

describe('Reminder-Pfad — Auto-Anforderung atomar', () => {
  const upcomingDeadline = (reminderDaysBefore: number) => ({
    id: 'dl-1',
    clientId: 'client-1',
    dueDate: new Date(Date.UTC(2026, 5, 20)),
    kind: 'USTA_MONATLICH',
    period: '2026-05',
    config: { reminderDaysBefore },
  });

  it('erzeugt Request + REMINDED + Audit-Eintrag in EINER runAtomic-Transaktion', async () => {
    const { db, tx, deps, recordEvidence, runAtomic } = makeHarness({
      upcoming: [upcomingDeadline(14)], // remindFrom = 06.06. ≤ now (09.06.)
    });

    const stats = await materializeTenantTaxDeadlines(deps, {
      tenantId: TENANT,
      systemStaffId: STAFF,
      now: NOW,
    });

    // Kandidaten-Query: nur PLANNED ohne Request, Reminder konfiguriert.
    // P-4: SQL-Vorfilter dueDate ≤ now + max(reminderDaysBefore) — ohne
    // geladene Configs ist das Fenster 0 Tage (lte = now).
    expect(db.taxDeadline.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT,
        status: 'PLANNED',
        requestId: null,
        config: { active: true, reminderDaysBefore: { gt: 0 } },
        client: { allowActive: true },
        dueDate: { lte: NOW },
      },
      include: { config: { select: { reminderDaysBefore: true } } },
    });

    expect(runAtomic).toHaveBeenCalledTimes(1);
    expect(tx.request.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: TENANT,
        clientId: 'client-1',
        priority: 'NORMAL',
        createdByStaff: STAFF,
        dueAt: new Date(Date.UTC(2026, 5, 20)),
        title: expect.stringContaining('2026-05'),
      }),
    });
    expect(tx.taxDeadline.update).toHaveBeenCalledWith({
      where: { id: 'dl-1' },
      data: { requestId: 'req-1', status: 'REMINDED' },
    });
    expect(recordEvidence).toHaveBeenCalledTimes(1);
    // Audit-Eintrag läuft auf DEMSELBEN Tx wie Request + Update
    expect(recordEvidence.mock.calls[0]![0]).toBe(tx);
    expect(recordEvidence.mock.calls[0]![1]).toEqual({
      tenantId: TENANT,
      actorType: 'SYSTEM',
      actorId: STAFF,
      action: 'tax_deadline.auto_request',
      resourceType: 'tax_deadline',
      resourceId: 'dl-1',
      after: { requestId: 'req-1', kind: 'USTA_MONATLICH', period: '2026-05' },
    });
    expect(stats.requestsCreated).toBe(1);
  });

  it('SQL-Vorfilter: Fenster = now + max(reminderDaysBefore) aus den geladenen Configs', async () => {
    // Config trägt zum Reminder-Fenster bei, auch wenn der Mandant (GwG)
    // keine neuen Kandidaten bekommt.
    const cfg = ustaMonthlyConfig({
      reminderDaysBefore: 14,
      client: { id: 'client-1', allowActive: false },
    });
    const { db, deps } = makeHarness({ configs: [cfg] });

    await materializeTenantTaxDeadlines(deps, {
      tenantId: TENANT,
      systemStaffId: STAFF,
      now: NOW,
    });

    const arg = db.taxDeadline.findMany.mock.calls[0]![0] as {
      where: { dueDate: { lte: Date } };
    };
    expect(arg.where.dueDate.lte).toEqual(
      new Date(NOW.getTime() + 14 * 24 * 60 * 60 * 1000),
    );
  });

  it('Reminder-Fenster noch nicht erreicht → kein Request', async () => {
    // remindFrom = 15.06. > now (09.06.)
    const { tx, deps, runAtomic } = makeHarness({ upcoming: [upcomingDeadline(5)] });

    const stats = await materializeTenantTaxDeadlines(deps, {
      tenantId: TENANT,
      systemStaffId: STAFF,
      now: NOW,
    });

    expect(runAtomic).not.toHaveBeenCalled();
    expect(tx.request.create).not.toHaveBeenCalled();
    expect(stats.requestsCreated).toBe(0);
  });

  it('Re-Check-Race: paralleler Lauf hat den Termin bereits versorgt → No-Op', async () => {
    const { tx, deps, recordEvidence } = makeHarness({ upcoming: [upcomingDeadline(14)] });
    tx.taxDeadline.findUnique.mockResolvedValue({ status: 'REMINDED', requestId: 'req-fremd' });

    const stats = await materializeTenantTaxDeadlines(deps, {
      tenantId: TENANT,
      systemStaffId: STAFF,
      now: NOW,
    });

    expect(tx.request.create).not.toHaveBeenCalled();
    expect(tx.taxDeadline.update).not.toHaveBeenCalled();
    expect(recordEvidence).not.toHaveBeenCalled();
    expect(stats.requestsCreated).toBe(0);
  });

  it('Re-Check: Termin inzwischen gelöscht → No-Op', async () => {
    const { tx, deps } = makeHarness({ upcoming: [upcomingDeadline(14)] });
    tx.taxDeadline.findUnique.mockResolvedValue(null);

    const stats = await materializeTenantTaxDeadlines(deps, {
      tenantId: TENANT,
      systemStaffId: STAFF,
      now: NOW,
    });

    expect(tx.request.create).not.toHaveBeenCalled();
    expect(stats.requestsCreated).toBe(0);
  });
});

describe('OVERDUE — § 108 (1) AO Tagesgrenze', () => {
  it('markiert nur Termine VOR UTC-Mitternacht des Stichtags (heute fällig ≠ überfällig)', async () => {
    const { db, deps } = makeHarness({ overdueCount: 3 });
    // Stichtag 10.06. spätabends: ein am 10.06. fälliger Termin hat bis
    // Tagesende Zeit und darf NICHT überfällig werden.
    const lateEvening = new Date('2026-06-10T22:00:00.000Z');

    const stats = await materializeTenantTaxDeadlines(deps, {
      tenantId: TENANT,
      systemStaffId: STAFF,
      now: lateEvening,
    });

    expect(db.taxDeadline.updateMany).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT,
        status: { in: ['PLANNED', 'REMINDED', 'IN_PROGRESS'] },
        // Grenze = UTC-Mitternacht des Stichtags, NICHT der Zeitstempel selbst
        dueDate: { lt: new Date(Date.UTC(2026, 5, 10)) },
      },
      data: { status: 'OVERDUE' },
    });
    expect(stats.markedOverdue).toBe(3);
  });

  it('am Folgetag (nach Tagesende) wandert der Termin in die OVERDUE-Menge', async () => {
    const { db, deps } = makeHarness({ overdueCount: 1 });
    const nextMorning = new Date('2026-06-11T00:30:00.000Z');

    await materializeTenantTaxDeadlines(deps, {
      tenantId: TENANT,
      systemStaffId: STAFF,
      now: nextMorning,
    });

    const arg = db.taxDeadline.updateMany.mock.calls[0]![0] as {
      where: { dueDate: { lt: Date } };
    };
    // Jetzt liegt die Grenze HINTER dem 10.06. — dueDate 10.06. < 11.06. ✓
    expect(arg.where.dueDate.lt).toEqual(new Date(Date.UTC(2026, 5, 11)));
    expect(arg.where.dueDate.lt.getTime()).toBeGreaterThan(Date.UTC(2026, 5, 10));
  });
});
