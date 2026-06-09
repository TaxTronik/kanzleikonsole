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
  endOfDueDay,
  generateDeadlines,
  SCHEDULE_LABELS,
  startOfUtcDay,
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

// Identisch zu fmtDateShort der Web-App (`new Intl.DateTimeFormat('de-DE')`).
const dateFormatter = new Intl.DateTimeFormat('de-DE');

export async function materializeTenantTaxDeadlines(
  deps: MaterializeDeps,
  params: MaterializeParams,
): Promise<MaterializeStats> {
  const { db } = deps;
  const { tenantId, systemStaffId } = params;
  const now = params.now ?? new Date();
  const horizonDays = params.horizonDays ?? 90;
  const horizon = new Date(now.getTime() + horizonDays * 24 * 60 * 60 * 1000);

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
  const region = ((regionRow?.value as { region?: string } | null)?.region ?? null) as GermanRegion | null;

  // 1. Aktive Configs laden
  const configs = await db.taxScheduleConfig.findMany({
    where: { tenantId, active: true },
    include: { client: { select: { id: true, allowActive: true } } },
  });
  stats.configsScanned = configs.length;

  // 2. Pro Config alle Kandidaten generieren und idempotent einfügen
  for (const cfg of configs) {
    // Übersprungen wenn Mandant nicht freigeschaltet (GwG)
    if (!cfg.client.allowActive) continue;

    const candidates = generateDeadlines(cfg.kind, now, horizon, cfg.hasDauerfrist, region, cfg.advised);
    for (const c of candidates) {
      // Niemals retrospektiv erzeugen — Mandanten werden oft unterjährig
      // übernommen, alte Perioden gehören dem Vorgänger. „Retrospektiv" ist
      // ein Termin erst NACH Ende seines Fälligkeitstags (§ 108 (1) AO) —
      // ein heute fälliger Termin wird noch angelegt.
      if (endOfDueDay(c.dueDate).getTime() < now.getTime()) continue;
      // Upsert über Unique (tenantId, clientId, kind, period)
      const existing = await db.taxDeadline.findUnique({
        where: {
          tenantId_clientId_kind_period: {
            tenantId,
            clientId: cfg.clientId,
            kind: c.kind,
            period: c.period,
          },
        },
      });
      if (existing) continue;

      await db.taxDeadline.create({
        data: {
          tenantId,
          clientId: cfg.clientId,
          configId: cfg.id,
          kind: c.kind,
          period: c.period,
          dueDate: c.dueDate,
        },
      });
      stats.deadlinesCreated += 1;
    }
  }

  // 3. Auto-Anforderungen für Termine im Reminder-Fenster erzeugen
  const upcoming = await db.taxDeadline.findMany({
    where: {
      tenantId,
      status: 'PLANNED',
      requestId: null,
      config: { reminderDaysBefore: { gt: 0 } },
    },
    include: { config: { select: { reminderDaysBefore: true } } },
  });
  for (const dl of upcoming) {
    const remindFrom = new Date(
      dl.dueDate.getTime() - (dl.config?.reminderDaysBefore ?? 0) * 24 * 60 * 60 * 1000,
    );
    if (remindFrom > now) continue;

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
  //    Tagesende), also dueDate < UTC-Mitternacht des Stichtags.
  const overdueResult = await db.taxDeadline.updateMany({
    where: {
      tenantId,
      status: { in: ['PLANNED', 'REMINDED', 'IN_PROGRESS'] },
      dueDate: { lt: startOfUtcDay(now) },
    },
    data: { status: 'OVERDUE' },
  });
  stats.markedOverdue = overdueResult.count;

  return stats;
}
