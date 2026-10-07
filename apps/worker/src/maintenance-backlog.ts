// =============================================================================
// Rückstand der Wartungsjobs: Health-Kennzahl und Alarm (P-17 / B14).
//
// audit-rotate und storage-orphan-cleanup arbeiten je Lauf bis zu einem
// Zeitbudget (run-budget.ts) und melden, was danach weiterhin fällig ist. Bisher
// stand nur diese Anzahl auf „System → Jobs“; ein Rückstand, der Lauf um Lauf
// bestehen blieb, fiel niemandem auf. Jeder vollständige Lauf übergibt hier
// seinen Rückstand je Tenant und erhält die Kennzahl für sein Job-Ergebnis
// (`backlogStatus`: Anzahl, Fälligkeit des ältesten offenen Eintrags, Läufe in
// Folge mit Rückstand, Alarm). GET /api/health/detail und die Jobübersicht
// lesen sie aus dem letzten erfolgreichen Lauf.
//
// Alarm (Entscheidung B14: „als Health-Kennzahl ausweisen und Mailalarm ab
// festzulegender Schwelle“), solange MAINTENANCE_BACKLOG_ALARM_THRESHOLD
// erreicht ist:
//   - Benachrichtigung an die aktiven ADMIN/PARTNER jeder betroffenen Kanzlei,
//     nur mit den Zahlen DIESER Kanzlei. Eine ungelesene wird aktualisiert; neu
//     angelegt wird höchstens eine je Empfänger und UTC-Tag (Tages-Dedupe-Index
//     notification_daily_dedupe).
//   - Mail an OPS_ALERT_EMAIL über sendOpsMail (der Alarmweg von health-alert)
//     mit den Gesamtzahlen ohne Tenant-Bezug, höchstens eine je Job und UTC-Tag
//     (Redis-Tagesmarke; scheitert der Versand, versucht es der nächste Lauf).
// Ohne Alarm werden offene Rückstandshinweise geschlossen. Empfänger, Hinweise
// und deren Abschluss laufen über die App-Rolle im SYSTEM-Kontext der Kanzlei
// (S-01); der Owner-Client liefert nur die Kanzleien mit offenem Hinweis.
//
// Fehler im Alarmweg werden protokolliert und brechen den Wartungslauf nicht
// ab: dessen Arbeit ist erledigt, ein Retry würde sie nur wiederholen.
// =============================================================================

import type { NotificationKind } from '@prisma/client';
import { JOB_QUEUES } from '@taxtronik/config/job-queues';
import { withSystemContext } from '@taxtronik/db';
import { resolveNotificationsTx } from '@taxtronik/db/notification';
import { env } from './env';
import { log } from './logger';
import { sendOpsMail } from './mailer';
import { notify } from './notify';
import { prismaOwner } from './prisma-owner';
import { connection } from './queues';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export interface MaintenanceBacklogThreshold {
  /** Vollständige Läufe in Folge mit Rückstand, ab denen alarmiert wird. */
  consecutiveRuns: number;
  /** Wie lange der älteste offene Eintrag höchstens fällig sein darf (ms). */
  maxOverdueMs: number;
}

/**
 * B14: Alarmschwelle der Wartungsjobs. Alarm, sobald ein Rückstand nach
 * `consecutiveRuns` vollständigen Läufen in Folge noch besteht ODER sein
 * ältester offener Eintrag seit mehr als `maxOverdueMs` fällig ist. Die Werte
 * stehen nur hier; Job-Ergebnis und Health-Ausgabe nennen sie mit, die
 * Betriebsdoku (docs/operations/day-2-operations.md) beschreibt sie.
 */
export const MAINTENANCE_BACKLOG_ALARM_THRESHOLD: Readonly<MaintenanceBacklogThreshold> =
  Object.freeze({ consecutiveRuns: 3, maxOverdueMs: 7 * DAY_MS });

/** Wartungsjobs mit Rückstandsmeldung (Schlüssel aus JOB_QUEUES). */
export type MaintenanceJob = 'auditRotate' | 'storageOrphanCleanup';

interface JobAlarm {
  kind: NotificationKind;
  label: string;
  /** Bezeichnung der offenen Einträge im Hinweis an die Kanzlei. */
  pending: string;
}

const JOB_ALARM: Readonly<Record<MaintenanceJob, JobAlarm>> = {
  auditRotate: {
    kind: 'SYSTEM_AUDIT_ARCHIVE_BACKLOG',
    label: 'Audit-Archivierung',
    pending: 'Fällige, noch nicht archivierte Audit-Einträge Ihrer Kanzlei',
  },
  storageOrphanCleanup: {
    kind: 'SYSTEM_STORAGE_CLEANUP_BACKLOG',
    label: 'Bereinigung verwaister Speicherobjekte',
    pending: 'Fällige, noch nicht bereinigte Speicherobjekte Ihrer Kanzlei',
  },
};

/** Rückstand eines Tenants nach dem Lauf. */
export interface TenantBacklog {
  tenantId: string;
  count: number;
  /** Fälligkeit des ältesten offenen Eintrags; null, wenn unbekannt. */
  oldestDueAt: Date | null;
}

/** Kennzahl im Job-Ergebnis — ohne Tenant-Bezug. */
export interface MaintenanceBacklogStatus {
  /** Fällige, weiterhin offene Einträge nach dem Lauf (wie `backlog`). */
  count: number;
  /** Fälligkeit des ältesten offenen Eintrags (ISO-8601); null ohne Rückstand. */
  oldestDueAt: string | null;
  /** Vollständige Läufe in Folge, die mit Rückstand endeten (dieser eingeschlossen). */
  consecutiveRuns: number;
  /** Alarmschwelle erreicht. */
  alarm: boolean;
  threshold: MaintenanceBacklogThreshold;
}

export interface BacklogEvaluation {
  consecutiveRuns: number;
  /** Wie lange der älteste offene Eintrag schon fällig ist; null ohne Angabe. */
  overdueMs: number | null;
  alarm: boolean;
}

/**
 * Pure Schwellenlogik (exportiert für den Unit-Test): Ohne Rückstand beginnt
 * die Zählung von vorn; mit Rückstand zählt der Lauf dazu, und der Alarm greift
 * ab der Lauf- ODER der Altersschwelle.
 */
export function evaluateMaintenanceBacklog(
  previousRuns: number,
  backlog: { count: number; oldestDueAt: Date | null },
  now: Date,
  threshold: MaintenanceBacklogThreshold = MAINTENANCE_BACKLOG_ALARM_THRESHOLD,
): BacklogEvaluation {
  if (backlog.count <= 0) return { consecutiveRuns: 0, overdueMs: null, alarm: false };
  const consecutiveRuns = Math.max(0, previousRuns) + 1;
  const overdueMs = backlog.oldestDueAt
    ? Math.max(0, now.getTime() - backlog.oldestDueAt.getTime())
    : null;
  const alarm =
    consecutiveRuns >= threshold.consecutiveRuns ||
    (overdueMs !== null && overdueMs > threshold.maxOverdueMs);
  return { consecutiveRuns, overdueMs, alarm };
}

/** „seit …“ im Dativ: 1 Tag, 9 Tagen, 1 Stunde, 5 Stunden, 20 Minuten. */
export function formatSince(ms: number): string {
  const days = Math.floor(ms / DAY_MS);
  if (days >= 1) return days === 1 ? '1 Tag' : `${days} Tagen`;
  const hours = Math.floor(ms / HOUR_MS);
  if (hours >= 1) return hours === 1 ? '1 Stunde' : `${hours} Stunden`;
  const minutes = Math.floor(ms / MINUTE_MS);
  if (minutes >= 1) return minutes === 1 ? '1 Minute' : `${minutes} Minuten`;
  return 'weniger als einer Minute';
}

/** Die Alarmschwelle als Satz für Hinweis und Mail. */
export function describeThreshold(
  threshold: MaintenanceBacklogThreshold = MAINTENANCE_BACKLOG_ALARM_THRESHOLD,
): string {
  const runs =
    threshold.consecutiveRuns === 1 ? '1 Lauf' : `${threshold.consecutiveRuns} Läufen in Folge`;
  return (
    `Rückstand besteht nach ${runs} noch oder der älteste offene Eintrag ist ` +
    `seit mehr als ${formatSince(threshold.maxOverdueMs)} fällig`
  );
}

function formatCount(count: number): string {
  return count.toLocaleString('de-DE');
}

interface BacklogSummary {
  count: number;
  oldestDueAt: Date | null;
  /** Nur Tenants mit Rückstand. */
  affected: TenantBacklog[];
}

function summarize(tenants: readonly TenantBacklog[]): BacklogSummary {
  const affected = tenants.filter((tenant) => tenant.count > 0);
  let oldestDueAt: Date | null = null;
  for (const { oldestDueAt: dueAt } of affected) {
    if (dueAt && (!oldestDueAt || dueAt < oldestDueAt)) oldestDueAt = dueAt;
  }
  const count = affected.reduce((sum, tenant) => sum + tenant.count, 0);
  return { count, oldestDueAt, affected };
}

const STATE_PREFIX = 'taxtronik:maintenance-backlog';
/** Länger als der größte Abstand zweier Läufe (audit-rotate: wöchentlich). */
const RUNS_TTL_SECONDS = 35 * 24 * 60 * 60;
/** Die Tagesmarke trägt das Datum im Schlüssel; die TTL räumt sie nur auf. */
const MAIL_MARK_TTL_SECONDS = 2 * 24 * 60 * 60;

function stateKey(job: MaintenanceJob, suffix: string): string {
  return `${STATE_PREFIX}:${JOB_QUEUES[job].name}:${suffix}`;
}

function stepFailed(job: MaintenanceJob, step: string, err: unknown): void {
  log.error(
    {
      component: 'maintenance-backlog',
      queue: JOB_QUEUES[job].name,
      step,
      err: err instanceof Error ? err.message : String(err),
    },
    'maintenance-backlog: Schritt fehlgeschlagen',
  );
}

async function loadPreviousRuns(job: MaintenanceJob): Promise<number> {
  try {
    const runs = Number((await connection.get(stateKey(job, 'runs'))) ?? 0);
    return Number.isSafeInteger(runs) && runs > 0 ? runs : 0;
  } catch (err) {
    // Ohne Vorzustand zählt dieser Lauf als erster; die Altersschwelle greift weiter.
    stepFailed(job, 'state', err);
    return 0;
  }
}

async function saveRuns(job: MaintenanceJob, runs: number): Promise<void> {
  try {
    if (runs > 0) await connection.set(stateKey(job, 'runs'), String(runs), 'EX', RUNS_TTL_SECONDS);
    else await connection.del(stateKey(job, 'runs'));
  } catch (err) {
    stepFailed(job, 'state', err);
  }
}

async function notifyTenantAdmins(
  job: MaintenanceJob,
  tenant: TenantBacklog,
  now: Date,
): Promise<number> {
  const { kind, label, pending } = JOB_ALARM[job];
  const since = tenant.oldestDueAt
    ? ` (ältester fällig seit ${formatSince(now.getTime() - tenant.oldestDueAt.getTime())})`
    : '';
  const title = `Wartungsrückstand: ${label}`;
  const body =
    `${pending}: ${formatCount(tenant.count)}${since}. ` +
    `Alarmschwelle: ${describeThreshold()}. Details unter System → Jobs.`;
  return withSystemContext(tenant.tenantId, async (tx) => {
    const admins = await tx.staffUser.findMany({
      where: {
        tenantId: tenant.tenantId,
        active: true,
        roles: { some: { role: { in: ['ADMIN', 'PARTNER'] } } },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    if (admins.length === 0) return 0;
    // Ungelesene Hinweise werden aktualisiert; der Tages-Dedupe-Index lässt je
    // Empfänger und UTC-Tag höchstens eine Neuanlage zu.
    const result = await notify(
      tx,
      admins.map((admin) => ({
        tenantId: tenant.tenantId,
        staffId: admin.id,
        kind,
        title,
        body,
        href: '/staff/admin/jobs',
        resourceType: 'tenant',
        resourceId: tenant.tenantId,
      })),
    );
    return result.created + result.updated;
  });
}

/** Schließt offene Rückstandshinweise in Tenants, die nicht (mehr) betroffen sind. */
async function resolveStaleNotifications(
  job: MaintenanceJob,
  affected: ReadonlySet<string>,
): Promise<number> {
  const { kind } = JOB_ALARM[job];
  // S-01: Owner nur für die mandantenübergreifende Liste der Kanzleien mit
  // offenem Hinweis (nur IDs); geschlossen wird im SYSTEM-Kontext der Kanzlei.
  const open = await prismaOwner.notification.findMany({
    where: { kind, readAt: null },
    select: { tenantId: true },
    distinct: ['tenantId'],
  });
  let resolved = 0;
  for (const { tenantId } of open) {
    if (affected.has(tenantId)) continue;
    resolved += await withSystemContext(tenantId, (tx) =>
      resolveNotificationsTx(tx, {
        tenantId,
        resources: [{ resourceType: 'tenant', resourceId: tenantId }],
        kinds: [kind],
      }),
    );
  }
  return resolved;
}

async function syncNotifications(
  job: MaintenanceJob,
  affected: readonly TenantBacklog[],
  now: Date,
): Promise<number> {
  try {
    await resolveStaleNotifications(job, new Set(affected.map((tenant) => tenant.tenantId)));
  } catch (err) {
    stepFailed(job, 'resolve', err);
  }
  let written = 0;
  for (const tenant of affected) {
    try {
      written += await notifyTenantAdmins(job, tenant, now);
    } catch (err) {
      stepFailed(job, 'notify', err);
    }
  }
  return written;
}

function alarmMail(
  job: MaintenanceJob,
  backlog: BacklogSummary,
  evaluation: BacklogEvaluation,
  now: Date,
): { subject: string; body: string } {
  const queue = JOB_QUEUES[job].name;
  const oldest = backlog.oldestDueAt
    ? `fällig seit ${backlog.oldestDueAt.toISOString()} (${formatSince(evaluation.overdueMs ?? 0)})`
    : 'unbekannt';
  const lines = [
    `Der Wartungsjob ${queue} (${JOB_ALARM[job].label}) baut seinen Rückstand nicht ab ` +
      `(Stand ${now.toISOString()}).`,
    '',
    `  Offene fällige Einträge:      ${formatCount(backlog.count)}`,
    `  Ältester offener Eintrag:     ${oldest}`,
    `  Läufe in Folge mit Rückstand: ${evaluation.consecutiveRuns}`,
    `  Betroffene Kanzleien:         ${backlog.affected.length}`,
    '',
    `Alarmschwelle: ${describeThreshold()}.`,
    '',
    'Nächste Schritte: System → Jobs prüfen und die Worker-Logs ansehen:',
    '  ./dc logs worker --tail 200',
    '',
    'Diese Mail kommt vom TaxTronik-Worker höchstens einmal je Job und Tag, solange die ' +
      'Schwelle erreicht ist. Die aktiven Admins und Partner der betroffenen Kanzleien ' +
      'erhalten zusätzlich eine Benachrichtigung.',
  ];
  return { subject: `[TaxTronik] Wartungsrückstand: ${queue}`, body: lines.join('\n') };
}

type MailOutcome = 'sent' | 'deduplicated' | 'not-configured' | 'failed';

/** Höchstens eine Mail je Job und UTC-Tag; ein gescheiterter Versand gibt den Tag frei. */
async function mailOncePerDay(
  job: MaintenanceJob,
  backlog: BacklogSummary,
  evaluation: BacklogEvaluation,
  now: Date,
): Promise<MailOutcome> {
  if (!env.OPS_ALERT_EMAIL) return 'not-configured';
  const mark = stateKey(job, `mail:${now.toISOString().slice(0, 10)}`);
  try {
    const claimed = await connection.set(
      mark,
      now.toISOString(),
      'EX',
      MAIL_MARK_TTL_SECONDS,
      'NX',
    );
    if (claimed !== 'OK') return 'deduplicated';
    const { subject, body } = alarmMail(job, backlog, evaluation, now);
    if (await sendOpsMail(subject, body)) return 'sent';
    await connection.del(mark);
    return 'failed';
  } catch (err) {
    stepFailed(job, 'mail', err);
    return 'failed';
  }
}

/**
 * Wertet den Rückstand eines vollständigen Laufs aus, alarmiert bei erreichter
 * Schwelle (Hinweis an ADMIN/PARTNER der betroffenen Kanzleien, Mail an
 * OPS_ALERT_EMAIL; beides je Tag dedupliziert) und liefert die Kennzahl für das
 * Job-Ergebnis. Wirft nicht.
 */
export async function recordMaintenanceBacklog(
  job: MaintenanceJob,
  tenants: readonly TenantBacklog[],
  now: Date = new Date(),
): Promise<MaintenanceBacklogStatus> {
  const backlog = summarize(tenants);
  const evaluation = evaluateMaintenanceBacklog(await loadPreviousRuns(job), backlog, now);
  await saveRuns(job, evaluation.consecutiveRuns);
  const notified = await syncNotifications(job, evaluation.alarm ? backlog.affected : [], now);
  if (evaluation.alarm) {
    const mail = await mailOncePerDay(job, backlog, evaluation, now);
    log.warn(
      {
        component: 'maintenance-backlog',
        queue: JOB_QUEUES[job].name,
        backlog: backlog.count,
        oldestDueAt: backlog.oldestDueAt?.toISOString() ?? null,
        consecutiveRuns: evaluation.consecutiveRuns,
        tenants: backlog.affected.length,
        notified,
        mail,
      },
      'maintenance-backlog: Alarmschwelle erreicht',
    );
  }
  return {
    count: backlog.count,
    oldestDueAt: backlog.oldestDueAt?.toISOString() ?? null,
    consecutiveRuns: evaluation.consecutiveRuns,
    alarm: evaluation.alarm,
    threshold: { ...MAINTENANCE_BACKLOG_ALARM_THRESHOLD },
  };
}
