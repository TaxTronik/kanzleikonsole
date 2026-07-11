// =============================================================================
// Steuertermin-Materialisierung — gemeinsamer Kern für Web-App und Worker.
//
// Generiert aus den aktiven Schedule-Konfigs konkrete Termine (TaxDeadline)
// für die nächsten N Tage, idempotent (Unique-Key tenant+client+kind+period
// verhindert Duplikate), erzeugt Auto-Anforderungen N Tage vor Fälligkeit
// (inkl. Audit-Eintrag `tax_deadline.auto_request`) und markiert abgelaufene
// Termine als OVERDUE — erst NACH Ende des Fälligkeitstags (§ 108 (1) AO).
//
// DB und Evidence kommen per Dependency-Injection (vgl. DI-Muster in
// packages/risk-layer): die Web-App ruft mit ihrem withTenantContext-Tx +
// evidenceService aus dem Container, der Worker mit prismaOwner +
// withWorkerTenantContext + EvidenceService. Dadurch gibt es genau EINE
// Logik — keine Web/Worker-Drift mehr (vormals ~150 Zeilen Duplikat).
// =============================================================================

import type { Prisma, TaxScheduleKind } from '@prisma/client';
import {
  berlinCalendarDate,
  generateDeadlines,
  SCHEDULE_LABELS,
  type GermanRegion,
} from './engine';

/**
 * DB-Zugriff: `Prisma.TransactionClient` deckt sowohl den Web-Tx
 * (withTenantContext) als auch den Worker-Owner-Client (BYPASSRLS) ab.
 * Alle Queries filtern explizit nach tenantId — für den Owner-Client nötig,
 * unter RLS redundant aber unschädlich.
 */
export type MaterializeDb = Prisma.TransactionClient;

/**
 * Audit-Eintrag für eine automatisch erzeugte Anforderung. Strukturell
 * kompatibel zu `AuditEventInput` aus @taxtronik/evidence — der Recorder wird
 * injiziert, damit dieses Paket frei von Evidence-/DB-Laufzeitabhängigkeiten
 * bleibt.
 */
export interface AutoRequestEvidence {
  tenantId: string;
  actorType: 'SYSTEM';
  actorId: string;
  action: 'tax_deadline.auto_request';
  resourceType: 'tax_deadline';
  resourceId: string;
  after: { requestId: string; kind: TaxScheduleKind; period: string };
}

export interface MaterializeDeps {
  /** Client für Reads, Deadline-Inserts und das OVERDUE-Update. */
  db: MaterializeDb;
  /**
   * Führt den Block „Request anlegen + Deadline updaten + Audit-Eintrag" in
   * EINER Transaktion aus. Web läuft bereits komplett in einer
   * withTenantContext-Transaktion (`(fn) => fn(tx)`); der Worker öffnet pro
   * Block eine withWorkerTenantContext-Transaktion.
   */
  runAtomic: <T>(fn: (tx: MaterializeDb) => Promise<T>) => Promise<T>;
  /** Audit-Eintrag — wird mit der runAtomic-Transaktion aufgerufen. */
  recordEvidence: (tx: MaterializeDb, event: AutoRequestEvidence) => Promise<unknown>;
}

export interface MaterializeParams {
  tenantId: string;
  /** Staff-ID, die als createdBy für Auto-Anforderungen verwendet wird. */
  systemStaffId: string;
  /** Wie weit in die Zukunft Termine erzeugt werden sollen (Default 90 Tage). */
  horizonDays?: number;
  /** Stichdatum, gegen das geprüft wird (Default: heute). */
  now?: Date;
}

export interface MaterializeStats {
  configsScanned: number;
  deadlinesCreated: number;
  requestsCreated: number;
  markedOverdue: number;
}

// Zeitzone fest auf Europe/Berlin — identisch zu fmtDateShort der Web-App.
// dueDate ist `@db.Date` (UTC-Mitternacht); ohne feste Zone würde ein Host mit
// negativem Offset in mandantengerichteten Anforderungstexten den Vortag zeigen.
const dateFormatter = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin' });

export async function materializeTenantTaxDeadlines(
  deps: MaterializeDeps,
  params: MaterializeParams,
): Promise<MaterializeStats> {
  const { db } = deps;
  const { tenantId, systemStaffId } = params;
  const now = params.now ?? new Date();
  const horizonDays = params.horizonDays ?? 90;
  const today = berlinCalendarDate(now);
  const horizon = new Date(today.getTime() + horizonDays * 24 * 60 * 60 * 1000);

  const stats: MaterializeStats = {
    configsScanned: 0,
    deadlinesCreated: 0,
    requestsCreated: 0,
    markedOverdue: 0,
  };

  // 0. Bundesland der Kanzlei (tenant_setting `tax_region`) für die
  //    Werktagsverschiebung.
  const regionRow = await db.tenantSetting.findUnique({
    where: { tenantId_key: { tenantId, key: 'tax_region' } },
  });
  const regionValue =
    (regionRow?.value as { region?: string; assumptionHoliday?: boolean } | null) ?? null;
  const region = (regionValue?.region ?? null) as GermanRegion | null;
  // Mariä Himmelfahrt ist in Bayern gemeindeabhängig (Art. 1 Abs. 1 BayFTG).
  // Default an; nur wenn der Tenant explizit deaktiviert (protestantisch
  // geprägte Sitz-Gemeinde), werden DE-BY-Fälligkeiten am 15.08. nicht
  // verschoben. Nur in DE-BY wirksam (DE-SL bleibt landesweit gesetzlich).
  const bavariaAssumption = regionValue?.assumptionHoliday !== false;

  // 1. Aktive Configs laden
  const configs = await db.taxScheduleConfig.findMany({
    where: { tenantId, active: true },
    include: { client: { select: { id: true, allowActive: true } } },
  });
  stats.configsScanned = configs.length;

  // 2. Pro Config alle Kandidaten generieren und idempotent einfügen.
  //    P-4: EIN createMany(skipDuplicates) über den Unique-Key
  //    (tenantId, clientId, kind, period) statt findUnique+create pro
  //    Kandidat — vorher 2 sequentielle Queries × Configs × Kandidaten
  //    (5.000–12.000 bei 1000 Mandanten), was die interaktive 15-s-Tx der
  //    Web-Action riss (P2028). skipDuplicates = ON CONFLICT DO NOTHING.
  const candidateRows: Prisma.TaxDeadlineCreateManyInput[] = [];
  for (const cfg of configs) {
    // Übersprungen wenn Mandant nicht freigeschaltet (GwG)
    if (!cfg.client.allowActive) continue;

    const candidates = generateDeadlines(
      cfg.kind,
      today,
      horizon,
      cfg.hasDauerfrist,
      region,
      cfg.advised,
      bavariaAssumption,
    );
    for (const c of candidates) {
      // Niemals retrospektiv erzeugen — Mandanten werden oft unterjährig
      // übernommen, alte Perioden gehören dem Vorgänger. „Retrospektiv" ist
      // ein Termin erst NACH Ende seines Fälligkeitstags (§ 108 (1) AO) —
      // ein heute fälliger Termin wird noch angelegt.
      if (c.dueDate.getTime() < today.getTime()) continue;
      candidateRows.push({
        tenantId,
        clientId: cfg.clientId,
        configId: cfg.id,
        kind: c.kind,
        period: c.period,
        dueDate: c.dueDate,
      });
    }
  }
  if (candidateRows.length > 0) {
    const created = await db.taxDeadline.createMany({
      data: candidateRows,
      skipDuplicates: true,
    });
    stats.deadlinesCreated = created.count;
  }

  // 3. Auto-Anforderungen für Termine im Reminder-Fenster erzeugen.
  //    P-4: SQL-Vorfilter auf dueDate ≤ now + max(reminderDaysBefore) —
  //    vorher wurden ALLE geplanten Termine (90-Tage-Horizont × Mandanten)
  //    geladen und der Großteil in JS verworfen.
  const maxReminderDays = configs.reduce((m, c) => Math.max(m, c.reminderDaysBefore), 0);
  const upcoming = await db.taxDeadline.findMany({
    where: {
      tenantId,
      status: 'PLANNED',
      requestId: null,
      // Dieselben Tore wie bei der Materialisierung (Schritt 2): nur AKTIVE
      // Configs und GwG-freigeschaltete Mandanten. Ohne diese Filter würde ein
      // Termin einer deaktivierten Config bzw. eines Mandanten mit entzogener
      // GwG-Freigabe trotzdem eine mandantengerichtete Anforderung auslösen.
      config: { active: true, reminderDaysBefore: { gt: 0 } },
      client: { allowActive: true },
      dueDate: { lte: new Date(today.getTime() + maxReminderDays * 24 * 60 * 60 * 1000) },
    },
    include: { config: { select: { reminderDaysBefore: true } } },
  });
  for (const dl of upcoming) {
    const remindFrom = new Date(
      dl.dueDate.getTime() - (dl.config?.reminderDaysBefore ?? 0) * 24 * 60 * 60 * 1000,
    );
    if (remindFrom > today) continue;

    const dueLabel = dateFormatter.format(dl.dueDate);
    const kindLabel = SCHEDULE_LABELS[dl.kind];
    // Request + Deadline-Update + Audit-Eintrag atomar — ein Crash dazwischen
    // würde sonst beim nächsten Lauf doppelte Anforderungen erzeugen.
    await deps.runAtomic(async (tx) => {
      // Re-Check in der Transaktion: ein paralleler Lauf (Web-Action vs.
      // Worker-Job) könnte den Termin inzwischen versorgt haben.
      const fresh = await tx.taxDeadline.findUnique({
        where: { id: dl.id },
        select: { status: true, requestId: true },
      });
      if (!fresh || fresh.status !== 'PLANNED' || fresh.requestId !== null) return;

      const req = await tx.request.create({
        data: {
          tenantId,
          clientId: dl.clientId,
          title: `${kindLabel} ${dl.period} bis ${dueLabel}`,
          description: `Bitte stellen Sie die Unterlagen für ${kindLabel} ${dl.period} bereit. Fälligkeit: ${dueLabel}.`,
          priority: 'NORMAL',
          createdByStaff: systemStaffId,
          dueAt: dl.dueDate,
        },
      });
      await tx.taxDeadline.update({
        where: { id: dl.id },
        data: { requestId: req.id, status: 'REMINDED' },
      });
      await deps.recordEvidence(tx, {
        tenantId,
        actorType: 'SYSTEM',
        actorId: systemStaffId,
        action: 'tax_deadline.auto_request',
        resourceType: 'tax_deadline',
        resourceId: dl.id,
        after: { requestId: req.id, kind: dl.kind, period: dl.period },
      });
      stats.requestsCreated += 1;
    });
  }

  // 4. Abgelaufene Termine als OVERDUE markieren — erst wenn der
  //    Fälligkeitstag KOMPLETT vorbei ist (§ 108 (1) AO: Frist läuft bis
  //    Tagesende), also dueDate < UTC-Mitternacht des heutigen Berlin-
  //    Kalendertags. Ein UTC-Vergleich gegen `now` wäre im Sommer zwischen
  //    22:00 und 24:00 Uhr um einen Kalendertag zu spät.
  const overdueResult = await db.taxDeadline.updateMany({
    where: {
      tenantId,
      status: { in: ['PLANNED', 'REMINDED', 'IN_PROGRESS'] },
      dueDate: { lt: today },
    },
    data: { status: 'OVERDUE' },
  });
  stats.markedOverdue = overdueResult.count;

  return stats;
}
