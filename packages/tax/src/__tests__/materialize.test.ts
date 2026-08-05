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
//   - Zweistufige Auto-Anforderung: (3a) Vorwarnung genau einmal an
//     HAUPTBEARBEITER (Fallback ADMIN/PARTNER), (3b) Versand erst nach
//     mindestens einem vollen Tageslauf Stopp-Fenster; Stopp blockt
//     (SQL-Filter + Tx-Re-Check); kein Versand nach Fälligkeit (gte heute)
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
const TODAY = new Date(Date.UTC(2026, 5, 9));

interface HarnessOptions {
  configs?: unknown[];
  upcoming?: unknown[];
  createdCount?: number;
  overdueCount?: number;
  hauptbearbeiter?: Array<{ clientId: string; staffId: string }>;
  adminPartners?: Array<{ id: string }>;
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
    clientResponsibility: { findMany: vi.fn().mockResolvedValue(opts.hauptbearbeiter ?? []) },
    staffUser: {
      findMany: vi.fn().mockResolvedValue(opts.adminPartners ?? [{ id: 'admin-1' }]),
    },
  };
  // Separater Tx-Fake: so ist nachweisbar, dass der atomare Block NICHT auf
  // dem äußeren db-Client läuft, sondern auf dem von runAtomic gereichten Tx.
  const tx = {
    taxDeadline: {
      findUnique: vi.fn().mockResolvedValue({
        status: 'PLANNED',
        requestId: null,
        staffNotifiedAt: null,
        autoRequestSuppressedAt: null,
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    request: { create: vi.fn().mockResolvedValue({ id: 'req-1' }) },
  };
  const recordEvidence = vi.fn().mockResolvedValue(undefined);
  const upsertStaffNotification = vi.fn().mockResolvedValue(undefined);
  const runAtomic = vi.fn(async (fn: (t: Db) => Promise<unknown>) => fn(tx as unknown as Db));
  const deps: MaterializeDeps = {
    db: db as unknown as Db,
    runAtomic: runAtomic as MaterializeDeps['runAtomic'],
    recordEvidence,
    upsertStaffNotification,
  };
  return { db, tx, deps, recordEvidence, runAtomic, upsertStaffNotification };
}

function ustaMonthlyConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cfg-1',
    clientId: 'client-1',
    kind: 'USTA_MONATLICH',
    hasDauerfrist: false,
    advised: false,
    autoRequest: true,
    reminderDaysBefore: 10,
    staffLeadDays: 3,
    client: { id: 'client-1', allowActive: true },
    ...overrides,
  };
}

const upcomingDeadline = (
  reminderDaysBefore: number,
  opts: { staffLeadDays?: number; staffNotifiedAt?: Date | null } = {},
) => ({
  id: 'dl-1',
  clientId: 'client-1',
  dueDate: new Date(Date.UTC(2026, 5, 20)),
  kind: 'USTA_MONATLICH',
  period: '2026-05',
  staffNotifiedAt: opts.staffNotifiedAt ?? null,
  autoRequestSuppressedAt: null,
  config: { reminderDaysBefore, staffLeadDays: opts.staffLeadDays ?? 0 },
  client: { name: 'Muster GmbH' },
});

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

describe('Auto-Anforderung (3b) — Versand atomar', () => {
  it('erzeugt Request + REMINDED + Audit-Eintrag in EINER runAtomic-Transaktion', async () => {
    const { db, tx, deps, recordEvidence, runAtomic } = makeHarness({
      upcoming: [upcomingDeadline(14)], // sendFrom = 06.06. ≤ heute (09.06.), lead 0
    });

    const stats = await materializeTenantTaxDeadlines(deps, {
      tenantId: TENANT,
      systemStaffId: STAFF,
      now: NOW,
    });

    // Kandidaten-Query: nur PLANNED ohne Request, Auto-Anforderung an, nicht
    // gestoppt. P-4: SQL-Vorfilter dueDate ∈ [heute, heute + max(Versand- +
    // Vorwarn-Tage)] — ohne geladene Configs ist das Fenster 0 Tage. Die
    // gte-Untergrenze härtet: nach Fälligkeit wird nie mehr versendet.
    expect(db.taxDeadline.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT,
        status: 'PLANNED',
        requestId: null,
        autoRequestSuppressedAt: null,
        config: { active: true, autoRequest: true },
        client: { allowActive: true },
        dueDate: { gte: TODAY, lte: TODAY },
      },
      include: {
        config: { select: { reminderDaysBefore: true, staffLeadDays: true } },
        client: { select: { name: true } },
      },
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
    // Mail/n8n macht der Adapter nach Commit — der Kern liefert die Daten.
    expect(stats.createdRequests).toEqual([
      {
        tenantId: TENANT,
        clientId: 'client-1',
        deadlineId: 'dl-1',
        requestId: 'req-1',
        kind: 'USTA_MONATLICH',
        period: '2026-05',
        dueDate: new Date(Date.UTC(2026, 5, 20)),
        title: 'USt-Voranmeldung (monatlich) 2026-05 bis 20.6.2026',
        description:
          'Bitte stellen Sie die Unterlagen für USt-Voranmeldung (monatlich) 2026-05 bereit. Fälligkeit: 20.6.2026.',
        priority: 'NORMAL',
      },
    ]);
  });

  it('SQL-Vorfilter: Fenster = heute + max(reminderDaysBefore + staffLeadDays)', async () => {
    // Config trägt zum Fenster bei, auch wenn der Mandant (GwG) keine neuen
    // Kandidaten bekommt. 14 + 3 = 17 Tage → lte 26.06.
    const cfg = ustaMonthlyConfig({
      reminderDaysBefore: 14,
      staffLeadDays: 3,
      client: { id: 'client-1', allowActive: false },
    });
    const { db, deps } = makeHarness({ configs: [cfg] });

    await materializeTenantTaxDeadlines(deps, {
      tenantId: TENANT,
      systemStaffId: STAFF,
      now: NOW,
    });

    const arg = db.taxDeadline.findMany.mock.calls[0]![0] as {
      where: { dueDate: { gte: Date; lte: Date } };
    };
    expect(arg.where.dueDate.gte).toEqual(TODAY);
    expect(arg.where.dueDate.lte).toEqual(new Date(Date.UTC(2026, 5, 26)));
  });

  it('Configs mit autoRequest = false vergrößern das Fenster nicht', async () => {
    const cfg = ustaMonthlyConfig({ autoRequest: false, reminderDaysBefore: 50 });
    const { db, deps } = makeHarness({ configs: [cfg] });

    await materializeTenantTaxDeadlines(deps, {
      tenantId: TENANT,
      systemStaffId: STAFF,
      horizonDays: 10,
      now: NOW,
    });

    const arg = db.taxDeadline.findMany.mock.calls[0]![0] as {
      where: { dueDate: { lte: Date } };
    };
    expect(arg.where.dueDate.lte).toEqual(TODAY);
  });

  it('Versand-Fenster noch nicht erreicht → kein Request', async () => {
    // sendFrom = 15.06. > heute (09.06.)
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
    tx.taxDeadline.findUnique.mockResolvedValue({
      status: 'REMINDED',
      requestId: 'req-fremd',
      staffNotifiedAt: null,
      autoRequestSuppressedAt: null,
    });

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

  it('Re-Check: Mitarbeiter hat inzwischen gestoppt → No-Op (Race Stopp vs. Lauf)', async () => {
    const { tx, deps } = makeHarness({ upcoming: [upcomingDeadline(14)] });
    tx.taxDeadline.findUnique.mockResolvedValue({
      status: 'PLANNED',
      requestId: null,
      staffNotifiedAt: null,
      autoRequestSuppressedAt: new Date('2026-06-09T09:59:00.000Z'),
    });

    const stats = await materializeTenantTaxDeadlines(deps, {
      tenantId: TENANT,
      systemStaffId: STAFF,
      now: NOW,
    });

    expect(tx.request.create).not.toHaveBeenCalled();
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

describe('Vorwarnung (3a) — interne Benachrichtigung vor dem Versand', () => {
  it('warnt genau einmal, setzt staffNotifiedAt und versendet NICHT im selben Lauf', async () => {
    // sendFrom = 10.06. (> heute), warnFrom = 07.06. (≤ heute) → nur warnen.
    const { tx, deps, runAtomic, upsertStaffNotification } = makeHarness({
      upcoming: [upcomingDeadline(10, { staffLeadDays: 3 })],
    });

    const stats = await materializeTenantTaxDeadlines(deps, {
      tenantId: TENANT,
      systemStaffId: STAFF,
      now: NOW,
    });

    expect(runAtomic).toHaveBeenCalledTimes(1);
    expect(tx.taxDeadline.update).toHaveBeenCalledWith({
      where: { id: 'dl-1' },
      data: { staffNotifiedAt: NOW },
    });
    // Fallback-Empfänger (kein HAUPTBEARBEITER hinterlegt) — auf dem Tx.
    expect(upsertStaffNotification).toHaveBeenCalledTimes(1);
    expect(upsertStaffNotification.mock.calls[0]![0]).toBe(tx);
    expect(upsertStaffNotification.mock.calls[0]![1]).toEqual({
      tenantId: TENANT,
      staffId: 'admin-1',
      kind: 'TAX_DEADLINE_REQUEST_PENDING',
      title: 'Auto-Anforderung an Muster GmbH geht am 10.6.2026 raus',
      body: 'USt-Voranmeldung (monatlich) 2026-05, fällig 20.6.2026. Stoppen, falls die Unterlagen bereits vorliegen.',
      href: '/staff/tax-deadlines/group?kind=USTA_MONATLICH&period=2026-05&q=Muster%20GmbH',
      resourceType: 'tax_deadline',
      resourceId: 'dl-1',
    });
    expect(tx.request.create).not.toHaveBeenCalled();
    expect(stats.staffWarned).toBe(1);
    expect(stats.requestsCreated).toBe(0);
  });

  it('adressiert HAUPTBEARBEITER statt des ADMIN/PARTNER-Fallbacks', async () => {
    const { deps, upsertStaffNotification } = makeHarness({
      upcoming: [upcomingDeadline(10, { staffLeadDays: 3 })],
      hauptbearbeiter: [
        { clientId: 'client-1', staffId: 'hb-1' },
        { clientId: 'client-1', staffId: 'hb-2' },
      ],
    });

    await materializeTenantTaxDeadlines(deps, {
      tenantId: TENANT,
      systemStaffId: STAFF,
      now: NOW,
    });

    const staffIds = upsertStaffNotification.mock.calls.map(
      (c) => (c[1] as { staffId: string }).staffId,
    );
    expect(staffIds).toEqual(['hb-1', 'hb-2']);
  });

  it('keine Vorwarnung bei staffLeadDays = 0 — Versand direkt im Fenster', async () => {
    const { tx, deps, upsertStaffNotification } = makeHarness({
      upcoming: [upcomingDeadline(14, { staffLeadDays: 0 })],
    });

    const stats = await materializeTenantTaxDeadlines(deps, {
      tenantId: TENANT,
      systemStaffId: STAFF,
      now: NOW,
    });

    expect(upsertStaffNotification).not.toHaveBeenCalled();
    expect(tx.request.create).toHaveBeenCalledTimes(1);
    expect(stats.staffWarned).toBe(0);
    expect(stats.requestsCreated).toBe(1);
  });

  it('spät angelegte Config im Versandfenster: erst warnen, Versand frühestens am Folgelauf', async () => {
    // sendFrom = 06.06. UND warnFrom = 03.06. liegen beide vor heute — der
    // Lauf darf trotzdem nur warnen (Stopp-Fenster von einem Tageslauf).
    const { tx, deps, upsertStaffNotification } = makeHarness({
      upcoming: [upcomingDeadline(14, { staffLeadDays: 3 })],
    });

    const stats = await materializeTenantTaxDeadlines(deps, {
      tenantId: TENANT,
      systemStaffId: STAFF,
      now: NOW,
    });

    expect(upsertStaffNotification).toHaveBeenCalledTimes(1);
    // Angekündigt wird der frühestmögliche Versand: morgen (10.06.).
    expect((upsertStaffNotification.mock.calls[0]![1] as { title: string }).title).toContain(
      '10.6.2026',
    );
    expect(tx.request.create).not.toHaveBeenCalled();
    expect(stats.staffWarned).toBe(1);
    expect(stats.requestsCreated).toBe(0);
  });

  it('Versand-Gate: Vorwarnung von HEUTE reicht nicht — erst der Folgelauf versendet', async () => {
    const warnedToday = upcomingDeadline(14, {
      staffLeadDays: 3,
      staffNotifiedAt: new Date('2026-06-09T07:35:00.000Z'),
    });
    const { tx, deps, runAtomic } = makeHarness({ upcoming: [warnedToday] });

    const stats = await materializeTenantTaxDeadlines(deps, {
      tenantId: TENANT,
      systemStaffId: STAFF,
      now: NOW,
    });

    expect(runAtomic).not.toHaveBeenCalled();
    expect(tx.request.create).not.toHaveBeenCalled();
    expect(stats.requestsCreated).toBe(0);
  });

  it('Versand-Gate: Vorwarnung von GESTERN → Versand läuft', async () => {
    const warnedYesterday = upcomingDeadline(14, {
      staffLeadDays: 3,
      staffNotifiedAt: new Date('2026-06-08T07:35:00.000Z'),
    });
    const { tx, deps } = makeHarness({ upcoming: [warnedYesterday] });

    const stats = await materializeTenantTaxDeadlines(deps, {
      tenantId: TENANT,
      systemStaffId: STAFF,
      now: NOW,
    });

    expect(tx.request.create).toHaveBeenCalledTimes(1);
    expect(stats.requestsCreated).toBe(1);
    expect(stats.staffWarned).toBe(0);
  });

  it('Tx-Re-Check der Vorwarnung: parallel bereits gewarnt → keine Doppel-Notification', async () => {
    const { tx, deps, upsertStaffNotification } = makeHarness({
      upcoming: [upcomingDeadline(10, { staffLeadDays: 3 })],
    });
    tx.taxDeadline.findUnique.mockResolvedValue({
      status: 'PLANNED',
      requestId: null,
      staffNotifiedAt: new Date('2026-06-09T07:35:00.000Z'),
      autoRequestSuppressedAt: null,
    });

    const stats = await materializeTenantTaxDeadlines(deps, {
      tenantId: TENANT,
      systemStaffId: STAFF,
      now: NOW,
    });

    expect(upsertStaffNotification).not.toHaveBeenCalled();
    expect(stats.staffWarned).toBe(0);
  });
});

describe('OVERDUE — § 108 (1) AO Tagesgrenze', () => {
  it('markiert nur Termine vor dem heutigen Berlin-Kalendertag', async () => {
    const { db, deps } = makeHarness({ overdueCount: 3 });
    // Stichtag 10.06. spätabends: ein am 10.06. fälliger Termin hat bis
    // Tagesende Zeit und darf NICHT überfällig werden.
    const lateEvening = new Date('2026-06-10T21:59:59.000Z');

    const stats = await materializeTenantTaxDeadlines(deps, {
      tenantId: TENANT,
      systemStaffId: STAFF,
      now: lateEvening,
    });

    expect(db.taxDeadline.updateMany).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT,
        status: { in: ['PLANNED', 'REMINDED', 'IN_PROGRESS'] },
        // Grenze = UTC-Kodierung des Berlin-Kalendertags, nicht `now`.
        dueDate: { lt: new Date(Date.UTC(2026, 5, 10)) },
      },
      data: { status: 'OVERDUE' },
    });
    expect(stats.markedOverdue).toBe(3);
  });

  it('wechselt in der Sommerzeit exakt um 00:00 Europe/Berlin auf den Folgetag', async () => {
    const { db, deps } = makeHarness();

    await materializeTenantTaxDeadlines(deps, {
      tenantId: TENANT,
      systemStaffId: STAFF,
      now: new Date('2026-06-10T22:00:00.000Z'),
    });

    const arg = db.taxDeadline.updateMany.mock.calls[0]![0] as {
      where: { dueDate: { lt: Date } };
    };
    expect(arg.where.dueDate.lt).toEqual(new Date(Date.UTC(2026, 5, 11)));
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
