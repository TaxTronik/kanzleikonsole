// =============================================================================
// Steuertermin-Materialisierung — gemeinsamer Kern für Web-App und Worker.
//
// Generiert aus den aktiven Schedule-Konfigs konkrete Termine (TaxDeadline)
// für die nächsten N Tage, idempotent (Unique-Key tenant+client+kind+period
// verhindert Duplikate), fährt die ZWEISTUFIGE Auto-Anforderung (interne
// Vorwarnung an Zuständige, danach Request-Anlage inkl. Audit-Eintrag
// `tax_deadline.auto_request`; Mitarbeiter können den Versand stoppen) und
// markiert abgelaufene Termine als OVERDUE — erst NACH Ende des
// Fälligkeitstags (§ 108 (1) AO). Die atomare Request-Anlage setzt den
// getrennten Benachrichtigungsstatus auf QUEUED; der Worker verarbeitet diese
// persistierte Queue nach dem Commit. `requestsCreated` ist nur das Signal,
// einen zeitnahen Worker-Lauf anzustoßen, keine I/O-Nutzlast.
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

/**
 * Interne Vorwarnung (Stufe 3a) an eine zuständige Person. Der Upsert selbst
 * wird injiziert (Web: notify(tx, …), Worker: upsertNotificationTx), damit
 * beide Prozesse ihre Idempotenz-/Dedupe-Mechanik behalten und dieses Paket
 * frei von DB-Laufzeitabhängigkeiten bleibt.
 */
export interface StaffNotificationInput {
  tenantId: string;
  staffId: string;
  kind: 'TAX_DEADLINE_REQUEST_PENDING';
  title: string;
  body: string;
  href: string;
  resourceType: 'tax_deadline';
  resourceId: string;
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
  /** Vorwarnungs-Notification — läuft in derselben runAtomic-Transaktion. */
  upsertStaffNotification: (tx: MaterializeDb, input: StaffNotificationInput) => Promise<unknown>;
  /** Schließt die Vorwarnung, sobald die Auto-Anforderung tatsächlich angelegt ist. */
  resolveStaffNotifications: (
    tx: MaterializeDb,
    input: { tenantId: string; resourceType: 'tax_deadline'; resourceId: string },
  ) => Promise<unknown>;
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
  /** Termine, für die in diesem Lauf die interne Vorwarnung rausging. */
  staffWarned: number;
}

// Zeitzone fest auf Europe/Berlin — identisch zu fmtDateShort der Web-App.
// dueDate ist `@db.Date` (UTC-Mitternacht); ohne feste Zone würde ein Host mit
// negativem Offset in mandantengerichteten Anforderungstexten den Vortag zeigen.
const dateFormatter = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin' });

async function readDeadlineCalendar(db: MaterializeDb, tenantId: string) {
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
  return { region, bavariaAssumption };
}

function warningLeadElapsed(staffLeadDays: number, staffNotifiedAt: Date | null, today: Date) {
  return (
    staffLeadDays === 0 ||
    (staffNotifiedAt !== null && berlinCalendarDate(staffNotifiedAt).getTime() < today.getTime())
  );
}

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
    staffWarned: 0,
  };

  const { region, bavariaAssumption } = await readDeadlineCalendar(db, tenantId);

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

  // 3. Zweistufige Auto-Anforderung:
  //    (3a) Interne Vorwarnung an Zuständige, sobald heute ≥ Fälligkeit −
  //         (reminderDaysBefore + staffLeadDays). Opt-out-Modell: wer die
  //         Unterlagen schon hat, stoppt den Versand auf der Gruppen-Seite.
  //    (3b) Versand: Request anlegen + REMINDED, sobald heute ≥ Fälligkeit −
  //         reminderDaysBefore UND die Vorwarnung mindestens einen Tageslauf
  //         alt ist (bzw. staffLeadDays = 0). Die Mandanten-Mail versendet
  //         QUEUED persistieren. Der separate Worker liest diesen Zustand
  //         nach Commit; requestsCreated dient nur als Enqueue-Signal.
  //    P-4: SQL-Vorfilter auf dueDate ≤ heute + max(Versand- + Vorwarn-Tage) —
  //    vorher wurden ALLE geplanten Termine (90-Tage-Horizont × Mandanten)
  //    geladen und der Großteil in JS verworfen.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const maxWindowDays = configs
    .filter((c) => c.autoRequest)
    .reduce((m, c) => Math.max(m, c.reminderDaysBefore + c.staffLeadDays), 0);
  const upcoming = await db.taxDeadline.findMany({
    where: {
      tenantId,
      status: 'PLANNED',
      requestId: null,
      // Gestoppte Pipelines bleiben dauerhaft draußen (Stopp ist aufhebbar).
      autoRequestSuppressedAt: null,
      // Dieselben Tore wie bei der Materialisierung (Schritt 2): nur AKTIVE
      // Configs mit eingeschalteter Auto-Anforderung und GwG-freigeschaltete
      // Mandanten. Ohne diese Filter würde ein Termin einer deaktivierten
      // Config bzw. eines Mandanten mit entzogener GwG-Freigabe trotzdem eine
      // mandantengerichtete Anforderung auslösen.
      config: { active: true, autoRequest: true },
      client: { allowActive: true },
      // Untergrenze heute: nach Ende des Fälligkeitstags wird NICHT mehr
      // automatisch angefordert („nie retroaktiv" gilt auch für den Versand —
      // der Termin ist dann OVERDUE und Mitarbeiter fordern manuell an).
      dueDate: { gte: today, lte: new Date(today.getTime() + maxWindowDays * DAY_MS) },
    },
    include: {
      config: { select: { reminderDaysBefore: true, staffLeadDays: true } },
      client: { select: { name: true } },
    },
  });

  const tomorrow = new Date(today.getTime() + DAY_MS);
  for (const dl of upcoming) {
    const cfg = dl.config;
    if (!cfg || cfg.reminderDaysBefore <= 0) continue;
    const sendFrom = new Date(dl.dueDate.getTime() - cfg.reminderDaysBefore * DAY_MS);
    const warnFrom = new Date(sendFrom.getTime() - cfg.staffLeadDays * DAY_MS);
    const dueLabel = dateFormatter.format(dl.dueDate);
    const kindLabel = SCHEDULE_LABELS[dl.kind];

    // (3a) Vorwarnung — genau einmal pro Termin (staffNotifiedAt-Guard).
    if (cfg.staffLeadDays > 0 && dl.staffNotifiedAt === null && warnFrom <= today) {
      // Versand frühestens am Folgelauf (Gate in 3b) — angekündigt wird das
      // tatsächliche Datum, auch wenn die Config spät angelegt wurde.
      const plannedSend = sendFrom.getTime() > tomorrow.getTime() ? sendFrom : tomorrow;
      const clientName = dl.client?.name ?? 'Mandant';
      await deps.runAtomic(async (tx) => {
        // TAX-DEADLINE-AUTOREQUEST-001: Empfänger erst im Claim-Tx bestimmen.
        // Eine zwischen Kandidaten-Read und Claim entzogene Zuständigkeit oder
        // deaktivierte Person darf weder Mandatsdaten erhalten noch den
        // ADMIN/PARTNER-Fallback unterdrücken. Die aktuelle
        // HAUPTBEARBEITER-Zuordnung ist zugleich das Mandantenzugriffs-Gate.
        const activeResponsibilities = await tx.clientResponsibility.findMany({
          where: {
            tenantId,
            clientId: dl.clientId,
            role: 'HAUPTBEARBEITER',
            staff: { tenantId, active: true },
          },
          select: { staffId: true },
        });
        let recipients = Array.from(new Set(activeResponsibilities.map((r) => r.staffId)));
        if (recipients.length === 0) {
          const activeAdminPartners = await tx.staffUser.findMany({
            where: {
              tenantId,
              active: true,
              roles: { some: { role: { in: ['ADMIN', 'PARTNER'] } } },
            },
            select: { id: true },
          });
          recipients = Array.from(new Set(activeAdminPartners.map((staff) => staff.id)));
        }
        // Ohne ein aktuell berechtigtes internes Ziel ist keine Vorwarnung
        // erfolgt. Insbesondere darf staffNotifiedAt dann nicht den späteren
        // Mandantenversand freischalten.
        if (recipients.length === 0) return;

        // TAX-DEADLINE-AUTOREQUEST-001: Die im vorgelagerten Read verwendeten
        // Zeitparameter werden im selben UPDATE erneut als Relations-Snapshot
        // geprüft. Wurde die Konfiguration parallel geändert, gewinnt kein
        // veralteter Zeitplan; der aktuelle Stand wird im nächsten Lauf neu
        // bewertet. Zugleich verhindert der CAS doppelte Vorwarnungen.
        const warningClaim = await tx.taxDeadline.updateMany({
          where: {
            id: dl.id,
            tenantId,
            status: 'PLANNED',
            requestId: null,
            staffNotifiedAt: null,
            autoRequestSuppressedAt: null,
            config: {
              active: true,
              autoRequest: true,
              reminderDaysBefore: cfg.reminderDaysBefore,
              staffLeadDays: cfg.staffLeadDays,
            },
            client: { allowActive: true },
          },
          data: { staffNotifiedAt: now },
        });
        if (warningClaim.count === 0) return;
        for (const staffId of recipients) {
          await deps.upsertStaffNotification(tx, {
            tenantId,
            staffId,
            kind: 'TAX_DEADLINE_REQUEST_PENDING',
            title: `Auto-Anforderung an ${clientName} geht am ${dateFormatter.format(plannedSend)} raus`,
            body: `${kindLabel} ${dl.period}, fällig ${dueLabel}. Stoppen, falls die Unterlagen bereits vorliegen.`,
            href: `/staff/tax-deadlines/group?kind=${dl.kind}&period=${encodeURIComponent(dl.period)}&q=${encodeURIComponent(clientName)}`,
            resourceType: 'tax_deadline',
            resourceId: dl.id,
          });
        }
        stats.staffWarned += 1;
      });
      // Frisch vorgewarnt — der Versand kommt frühestens mit dem Folgelauf.
      continue;
    }

    // (3b) Versand — Stopp-Fenster von mindestens einem vollen Tageslauf.
    if (sendFrom.getTime() > today.getTime()) continue;
    const warnSatisfied = warningLeadElapsed(cfg.staffLeadDays, dl.staffNotifiedAt, today);
    if (!warnSatisfied) continue;

    // Request + Deadline-Update + Audit-Eintrag atomar — ein Crash dazwischen
    // würde sonst beim nächsten Lauf doppelte Anforderungen erzeugen.
    await deps.runAtomic(async (tx) => {
      // Echte CAS-Beanspruchung statt Read-then-Write: bei parallelem Web-/
      // Worker-Lauf gewinnt exakt eine Transaktion. Da Claim, Request,
      // Deadline-Link und Audit in derselben DB-Transaktion liegen, gibt es
      // weder einen dauerhaft hängenden Claim noch eine verwaiste Request.
      const claimedAt = new Date();
      const claim = await tx.taxDeadline.updateMany({
        where: {
          id: dl.id,
          tenantId,
          status: 'PLANNED',
          requestId: null,
          autoRequestSuppressedAt: null,
          autoRequestClaimedAt: null,
          // Die Freigaben werden im CAS erneut geprüft: Konfiguration oder
          // Mandant können nach dem vorgelagerten Read deaktiviert worden
          // sein. Ohne diese Tore könnte der bereits geladene Kandidat trotz
          // zwischenzeitlichem Stopp noch Request und Mail erzeugen.
          // Die Zeitparameter gehören ebenfalls zum CAS-Snapshot. Eine
          // parallele Verringerung von reminderDaysBefore darf keinen zu
          // frühen Versand auslösen; ein neu gesetzter staffLeadDays-Wert
          // darf die interne Vorwarnung nicht umgehen.
          config: {
            active: true,
            autoRequest: true,
            reminderDaysBefore: cfg.reminderDaysBefore,
            staffLeadDays: cfg.staffLeadDays,
          },
          client: { allowActive: true },
        },
        data: { autoRequestClaimedAt: claimedAt },
      });
      if (claim.count === 0) return;

      const title = `${kindLabel} ${dl.period} bis ${dueLabel}`;
      const description = `Bitte stellen Sie die Unterlagen für ${kindLabel} ${dl.period} bereit. Fälligkeit: ${dueLabel}.`;
      const req = await tx.request.create({
        data: {
          tenantId,
          clientId: dl.clientId,
          title,
          description,
          priority: 'NORMAL',
          createdByStaff: systemStaffId,
          dueAt: dl.dueDate,
          taxDeadlineId: dl.id,
        },
      });
      await tx.taxDeadline.update({
        where: { id: dl.id },
        data: {
          requestId: req.id,
          status: 'REMINDED',
          autoRequestClaimedAt: null,
          // TAX-DEADLINE-AUTOREQUEST-001: Request-Anlage und Vormerkung des
          // davon getrennten Benachrichtigungswegs sind eine atomare Einheit.
          // QUEUED behauptet weder Versand noch Zugang beim Mandanten.
          autoRequestNotificationStatus: 'QUEUED',
          autoRequestNotificationAttemptCount: 0,
          autoRequestNotificationLastAttemptAt: null,
          autoRequestNotificationNextAttemptAt: now,
          autoRequestNotificationAcceptedAt: null,
          autoRequestNotificationLastError: null,
          autoRequestNotificationEscalatedAt: null,
        },
      });
      await deps.resolveStaffNotifications(tx, {
        tenantId,
        resourceType: 'tax_deadline',
        resourceId: dl.id,
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
