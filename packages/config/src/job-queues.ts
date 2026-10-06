/**
 * Runtime-light contracts shared by BullMQ producers, workers and operations UI.
 *
 * This module deliberately contains no BullMQ or Redis imports. It is the single
 * source for queue names and repeat metadata without pulling worker runtime code
 * into the web application.
 */

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** BullMQ job options of every run a repeat scheduler creates (plain data). */
export interface ScheduledJobOptions {
  attempts: number;
  backoff: { type: 'exponential'; delay: number };
}

/**
 * F-17: every cron pattern names its time zone. Without `tz` BullMQ evaluates the
 * pattern in the process time zone (TZ=Europe/Berlin in the containers, UTC or
 * anything else elsewhere), so labels and documentation said UTC while the
 * production worker ran on Berlin local time.
 *
 * - UTC: nightly maintenance (backup, audit sealing/verification/rotation,
 *   retention and cleanup). These times have always been documented in UTC
 *   (labels, scheduler comments, GoBD/DSGVO documentation, ADR-0004) and
 *   evidence-seal seals UTC days. UTC has no daylight-saving gaps, so the
 *   02:30/02:45 runs are neither shifted nor duplicated on switch days.
 * - Europe/Berlin: jobs tied to the office day (reminders, expiry checks,
 *   deadline materialisation, feeds). None of them lies in the 02:00-03:00
 *   switch window.
 */
export type ScheduleTimeZone = 'UTC' | 'Europe/Berlin';

export interface QueueScheduleDefinition {
  schedulerId: string;
  repeat: Readonly<
    | { every: number }
    | {
        pattern: string;
        tz: ScheduleTimeZone;
      }
  >;
  /** Retry policy of the scheduled runs; omitted = a single attempt. */
  jobOptions?: Readonly<ScheduledJobOptions>;
  /** Longest normal gap between two scheduled runs (cron windows included). */
  expectedMaxGapMs: number;
  /** Extra text for the generated log label (the timing part is derived from `repeat`). */
  labelNote?: string;
}

interface QueueDefinition {
  name: string;
  schedule: QueueScheduleDefinition | null;
}

const BERLIN = 'Europe/Berlin';
const UTC = 'UTC';

/**
 * P-05: Mindestabstand zwischen zwei Rolling-Ankern desselben Tenants. Der
 * 2-Sekunden-Takt bleibt, damit offene Rechnungs- und GwG-Ereignisse sofort
 * extern verankert werden; alle übrigen Einträge eines Tenants fasst höchstens
 * ein RFC-3161-Stempel je Intervall zusammen.
 */
export const AUDIT_ANCHOR_MIN_TENANT_INTERVAL_MS = MINUTE;

// RF-2: Gemeinsame Retry-Policy für periodische Wartungs-Jobs. Ein transienter
// Redis-/DB-/Netz-Fehler um die nächtliche Laufzeit soll den Job nicht bis zum
// nächsten Kalendertag ausfallen lassen (v. a. den Integritäts-Check
// audit-verify-check). Alle diese Jobs sind idempotent. Die Minuten-Jobs
// (health-alert, n8n-outbox-reconcile, ...) brauchen das nicht — der nächste
// Lauf kommt ohnehin gleich.
const DAILY_RETRY = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5 * MINUTE },
} as const satisfies ScheduledJobOptions;

// Backup und Restore-Drill: zwei Versuche mit großem Abstand, damit ein
// transienter S3-/DB-Fehler nicht bis zum nächsten Tag bzw. Monat wartet.
const BACKUP_RETRY = {
  attempts: 2,
  backoff: { type: 'exponential', delay: 30 * MINUTE },
} as const satisfies ScheduledJobOptions;

/**
 * All queues consumed by the worker. Object order is the display order used by
 * the operations page and by the scheduler registration log.
 *
 * R-13: the worker derives its producer queues, the repeat schedulers and the
 * worker registry from this object. A new queue is added here (plus its data
 * contract in QueueJobDataByName) and its processor in the worker registry.
 */
export const JOB_QUEUES = {
  mailboxPoll: {
    name: 'mailbox-poll',
    schedule: {
      schedulerId: 'periodic-mailbox-poll',
      repeat: { every: 5 * MINUTE },
      expectedMaxGapMs: 5 * MINUTE,
    },
  },
  sanctionsRefresh: {
    name: 'sanctions-refresh',
    schedule: {
      schedulerId: 'daily-sanctions-refresh',
      repeat: { pattern: '15 5 * * *', tz: BERLIN },
      jobOptions: DAILY_RETRY,
      expectedMaxGapMs: DAY,
    },
  },
  auditAnchor: {
    name: 'audit-anchor',
    schedule: {
      // Rolling dual stamp: frequent reconciliation, but no TSA call in the
      // business transaction. A tick coalesces bursts by timestamping only the
      // latest committed chain tip per tenant.
      schedulerId: 'rolling-audit-anchor',
      repeat: { every: 2 * SECOND },
      expectedMaxGapMs: 2 * SECOND,
      labelNote: `per tenant >= ${AUDIT_ANCHOR_MIN_TENANT_INTERVAL_MS / SECOND} sec unless invoice/gwg`,
    },
  },
  evidenceSeal: {
    name: 'evidence-seal',
    schedule: {
      schedulerId: 'daily-seal',
      repeat: { pattern: '30 2 * * *', tz: UTC },
      // RF-2: Retries für den Versiegelungslauf — ein transienter Fehler
      // (TSA/DB kurz weg) soll nicht bis zum nächsten Kalendertag warten.
      // Verpasste Tage holt der Lauf ohnehin per Backfill nach.
      jobOptions: DAILY_RETRY,
      expectedMaxGapMs: DAY,
    },
  },
  auditVerify: {
    name: 'audit-verify-check',
    schedule: {
      schedulerId: 'daily-audit-verify',
      repeat: { pattern: '45 2 * * *', tz: UTC },
      jobOptions: DAILY_RETRY,
      expectedMaxGapMs: DAY,
    },
  },
  auditRotate: {
    name: 'audit-rotate',
    schedule: {
      schedulerId: 'weekly-audit-rotate',
      repeat: { pattern: '0 3 * * 0', tz: UTC },
      jobOptions: DAILY_RETRY,
      expectedMaxGapMs: 7 * DAY,
    },
  },
  gwgExpiry: {
    name: 'gwg-expiry-check',
    schedule: {
      schedulerId: 'daily-gwg-expiry',
      repeat: { pattern: '0 7 * * *', tz: BERLIN },
      jobOptions: DAILY_RETRY,
      expectedMaxGapMs: DAY,
    },
  },
  invoiceOverdue: {
    name: 'invoice-overdue-check',
    schedule: {
      schedulerId: 'daily-invoice-overdue',
      repeat: { pattern: '15 7 * * *', tz: BERLIN },
      jobOptions: DAILY_RETRY,
      expectedMaxGapMs: DAY,
    },
  },
  taxDeadlineMaterialize: {
    name: 'tax-deadline-materialize',
    schedule: {
      schedulerId: 'daily-tax-deadline-materialize',
      repeat: { pattern: '30 7 * * *', tz: BERLIN },
      jobOptions: DAILY_RETRY,
      expectedMaxGapMs: DAY,
    },
  },
  taxNewsFetch: {
    name: 'tax-news-fetch',
    schedule: {
      // BMF/BFH-RSS-Feeds tagsüber aktuell halten (Insert ist idempotent, neue
      // Items werden nur einmal angelegt). Keep the existing ID: upsert
      // replaces the former daily schedule in-place instead of adding one.
      schedulerId: 'daily-tax-news-fetch',
      repeat: { pattern: '30 6-20/2 * * *', tz: BERLIN },
      jobOptions: DAILY_RETRY,
      // 20:30 to 06:30 is the longest intentional overnight pause.
      expectedMaxGapMs: 10 * HOUR,
    },
  },
  remindersDaily: {
    name: 'reminders-daily',
    schedule: {
      // Reminder-Bündel: Einspruchsfristen + Wiedervorlagen + überfällige
      // Pendelordner. Notifications werden idempotent angelegt.
      schedulerId: 'daily-reminders',
      repeat: { pattern: '45 7 * * *', tz: BERLIN },
      jobOptions: DAILY_RETRY,
      expectedMaxGapMs: DAY,
    },
  },
  magicLinkCleanup: {
    name: 'magic-link-cleanup',
    schedule: {
      // H6: Die Magic-Link-Tabelle wächst sonst unbegrenzt.
      schedulerId: 'daily-magic-link-cleanup',
      repeat: { pattern: '30 3 * * *', tz: UTC },
      jobOptions: DAILY_RETRY,
      expectedMaxGapMs: DAY,
    },
  },
  dsgvoRetention: {
    name: 'dsgvo-retention',
    schedule: {
      // Löscht Notifications (>1J), Phone-Notes (>3J) und nullt
      // client_contact.lastLoginAt (>2J). Siehe dsgvo-konzept.md 2.2.
      schedulerId: 'daily-dsgvo-retention',
      repeat: { pattern: '0 4 * * *', tz: UTC },
      jobOptions: DAILY_RETRY,
      expectedMaxGapMs: DAY,
    },
  },
  poaExpiry: {
    name: 'poa-expiry-check',
    schedule: {
      // Nach gwg-expiry/invoice-overdue.
      schedulerId: 'daily-poa-expiry',
      repeat: { pattern: '20 7 * * *', tz: BERLIN },
      jobOptions: DAILY_RETRY,
      expectedMaxGapMs: DAY,
    },
  },
  backupRun: {
    name: 'backup-run',
    schedule: {
      // P1-24: automatisches tägliches Backup (nachts, vor allem anderen).
      // Streamt pg_dump → S3. Ohne Zeitplan hatten update-los betriebene
      // Installationen faktisch kein aktuelles Backup; der Staleness-Alarm in
      // health-alert schlägt an, falls dieser Lauf ausfällt.
      schedulerId: 'daily-backup-run',
      repeat: { pattern: '0 1 * * *', tz: UTC },
      jobOptions: BACKUP_RETRY,
      expectedMaxGapMs: DAY,
    },
  },
  backupDrill: {
    name: 'backup-drill',
    schedule: {
      // Restore-Drill: beweisbarer Wirksamkeitsnachweis der Sicherung
      // (Art. 32 DSGVO / GoBD).
      schedulerId: 'monthly-backup-drill',
      repeat: { pattern: '0 5 1 * *', tz: UTC },
      jobOptions: BACKUP_RETRY,
      expectedMaxGapMs: 31 * DAY,
    },
  },
  healthAlert: {
    name: 'health-alert',
    schedule: {
      // Down-/Up-Mails an OPS_ALERT_EMAIL bei Infrastruktur-Ausfall (No-Op,
      // solange die Adresse nicht gesetzt ist).
      schedulerId: 'health-alert',
      repeat: { every: 5 * MINUTE },
      expectedMaxGapMs: 5 * MINUTE,
    },
  },
  updateCheck: {
    name: 'update-check',
    schedule: {
      // P-21: signiertes Update-Manifest abrufen und das Ergebnis je Tenant
      // speichern; die Admin-Übersicht liest nur noch dieses Ergebnis.
      schedulerId: 'update-check',
      repeat: { every: 6 * HOUR },
      jobOptions: DAILY_RETRY,
      expectedMaxGapMs: 6 * HOUR,
    },
  },
  fidoMdsRefresh: {
    name: 'fido-mds-refresh',
    schedule: {
      // P-23: lädt und prüft den signierten FIDO-MDS-BLOB und speichert den
      // Stand für die Hardware-Anmeldung. Die Web-App sperrt fail-closed, wenn
      // die letzte erfolgreiche Prüfung älter als eine Stunde ist; der
      // 20-Minuten-Takt verkraftet damit zwei ausgefallene Läufe.
      schedulerId: 'fido-mds-refresh',
      repeat: { every: 20 * MINUTE },
      expectedMaxGapMs: 20 * MINUTE,
    },
  },
  n8nDeliver: { name: 'n8n-deliver', schedule: null },
  n8nOutboxReconcile: {
    name: 'n8n-outbox-reconcile',
    schedule: {
      // S15 Outbox-Reconciliation: stuck PENDING-Reihen erneut einreihen
      // (App-Crash zwischen Outbox-Write und Queue-Add).
      schedulerId: 'n8n-outbox-reconcile',
      repeat: { every: 5 * MINUTE },
      expectedMaxGapMs: 5 * MINUTE,
    },
  },
  workflowN8nDispatch: {
    name: 'workflow-n8n-dispatch',
    schedule: {
      // Fachliche Workflow-Events liegen vor dem Outbox-Handoff dauerhaft in der
      // DB. WRITE_FAILED-/Crash-Fälle werden mit stabilem Dedupe-Key nachgezogen.
      schedulerId: 'workflow-n8n-dispatch-reconcile',
      repeat: { every: MINUTE },
      expectedMaxGapMs: MINUTE,
    },
  },
  workflowFeedback: {
    name: 'workflow-feedback',
    schedule: {
      schedulerId: 'workflow-feedback',
      repeat: { every: MINUTE },
      expectedMaxGapMs: MINUTE,
    },
  },
  workflowAutoResume: {
    name: 'workflow-auto-resume',
    schedule: {
      // F-13: setzt pausierte Workflows mit erreichtem Pausentermin fort (vorher
      // nur beim Öffnen der Workflow-Seite eines Mandanten). Kein Retry nötig —
      // der nächste Lauf folgt nach 5 Minuten.
      schedulerId: 'workflow-auto-resume',
      repeat: { every: 5 * MINUTE },
      expectedMaxGapMs: 5 * MINUTE,
    },
  },
  storageOrphanCleanup: {
    name: 'storage-orphan-cleanup',
    schedule: {
      schedulerId: 'storage-orphan-cleanup',
      repeat: { every: 6 * HOUR },
      jobOptions: DAILY_RETRY,
      expectedMaxGapMs: 6 * HOUR,
    },
  },
  portalInboxCleanup: {
    name: 'portal-inbox-cleanup',
    schedule: {
      schedulerId: 'portal-inbox-cleanup',
      repeat: { every: 6 * HOUR },
      jobOptions: DAILY_RETRY,
      expectedMaxGapMs: 6 * HOUR,
    },
  },
  n8nRetention: {
    name: 'n8n-retention',
    schedule: {
      // Begrenzte n8n-Historie: normale Terminal-Events 90 Tage, Fehler/Partial
      // 180 Tage. Der Worker löscht nur weiterhin terminale Reihen in Batches.
      schedulerId: 'daily-n8n-retention',
      repeat: { pattern: '45 3 * * *', tz: UTC },
      jobOptions: DAILY_RETRY,
      expectedMaxGapMs: DAY,
    },
  },
  riskAnalyseLlm: { name: 'risk-analyse-llm', schedule: null },
  reminderDoneNotify: { name: 'reminder-done-notify', schedule: null },
  mailOutboxDeliver: {
    name: 'mail-outbox-deliver',
    schedule: {
      // F-08: Mandanten-Mails aus der Mail-Outbox. Die Web-App stößt den Job
      // nach jedem fachlichen Commit an; der Minutentakt holt verlorene
      // Anstöße, fällige Wiederholungen und hängende Versandversuche nach.
      // Kein BullMQ-Retry: der Versandzustand liegt in der Datenbank.
      schedulerId: 'mail-outbox-deliver',
      repeat: { every: MINUTE },
      expectedMaxGapMs: MINUTE,
    },
  },
} as const satisfies Record<string, QueueDefinition>;

export type JobQueueKey = keyof typeof JOB_QUEUES;

/** Keys of JOB_QUEUES in declaration (display/registration) order. */
export const JOB_QUEUE_KEYS: readonly JobQueueKey[] = Object.freeze(
  Object.keys(JOB_QUEUES) as JobQueueKey[],
);

export type QueueName = (typeof JOB_QUEUES)[keyof typeof JOB_QUEUES]['name'];

export interface EvidenceSealJob {
  tenantId?: string;
  sealDate?: string;
}

export interface AuditAnchorJob {
  /** Omit for the frequent global reconciliation tick. */
  tenantId?: string;
}

export interface ChecksJob {
  /** Optional: only process one tenant (manual trigger). */
  tenantId?: string;
  /** Optional: staff member who initiated a manual check. */
  requestedByStaffId?: string;
  requestId?: string;
}

/** New jobs address one delivery; outboxId tolerates queued legacy jobs. */
export type N8nDeliverJob =
  | { deliveryId: string; outboxId?: never }
  | { outboxId: string; deliveryId?: never };

/**
 * Delayed completion notification to the delegating staff member (`staffId`).
 * S-06 follow-up: the job only carries ids. The worker loads subject, client
 * and the name of the completing staff member from the reminder when it
 * delivers, so neither the subject nor a name is kept in Redis (AOF on disk).
 */
export interface ReminderDoneNotifyJob {
  tenantId: string;
  reminderId: string;
  staffId: string;
}

/**
 * Payload of jobs enqueued before the S-06 follow-up (subject and name in
 * Redis). The worker still accepts it for queued jobs but reads the current
 * values from the database; producers must not create it anymore.
 */
export interface LegacyReminderDoneNotifyJob extends ReminderDoneNotifyJob {
  clientId: string | null;
  subject: string;
  doneByName: string;
}

/**
 * S-06 follow-up: job options of the delayed completion notification (the
 * delay itself is the producer's undo window). A completed job is kept 24 h,
 * a failed one 7 days for diagnosis; the former count caps (100/200) still
 * bound the queue. `age` is in seconds.
 */
export const REMINDER_DONE_NOTIFY_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 30 * SECOND },
  removeOnComplete: { age: DAY / SECOND, count: 100 },
  removeOnFail: { age: (7 * DAY) / SECOND, count: 200 },
} as const;

/**
 * S-06: the job only references the analysis. The worker loads the facts from
 * the database under the analysis lock and runs only if their SHA-256 (hex,
 * UTF-8, as `riskSourceHash` in @taxtronik/db/risk-analysis) still equals
 * `sourceHash`, so no client facts are kept in Redis (AOF on disk).
 */
export interface RiskAnalyseLlmJob {
  tenantId: string;
  analysisId: string;
  sourceHash: string;
}

/**
 * Payload of jobs enqueued before S-06 (full facts in Redis). The worker still
 * accepts it for in-flight jobs; producers must not create it anymore.
 */
export interface LegacyRiskAnalyseLlmJob {
  tenantId: string;
  analysisId: string;
  sourceText: string;
  optionen?: Record<string, unknown>;
}

/**
 * S-06: job options of the on-demand LLM enrichment. The UI reads success from
 * `llmEnrichedAt`, so a completed job is only kept 24 h for diagnosis. A failed
 * job is how the UI learns about a final failure (getRiskAnalyseJobState), so
 * it stays 7 days — long enough to be seen after a weekend or a week off. The
 * former count caps (100/200) still bound the queue. `age` is in seconds.
 */
export const RISK_ANALYSE_LLM_JOB_OPTIONS = {
  attempts: 2,
  backoff: { type: 'exponential', delay: 5 * SECOND },
  removeOnComplete: { age: DAY / SECOND, count: 100 },
  removeOnFail: { age: (7 * DAY) / SECOND, count: 200 },
} as const;

/**
 * F-08: job options of the post-commit nudge of mail-outbox-deliver. The job
 * carries no data (the outbox rows are the state) and is never retried by
 * BullMQ; the per-minute scheduler run picks up anything a lost nudge missed.
 */
export const MAIL_OUTBOX_KICK_JOB_OPTIONS = {
  attempts: 1,
  removeOnComplete: { age: DAY / SECOND, count: 100 },
  removeOnFail: { age: (7 * DAY) / SECOND, count: 100 },
} as const;

type EmptyJob = Record<string, never>;

/** Compile-time mapping used by typed producer/consumer factories. */
export type QueueJobDataByName = {
  [JOB_QUEUES.mailboxPoll.name]: ChecksJob;
  [JOB_QUEUES.sanctionsRefresh.name]: ChecksJob;
  [JOB_QUEUES.auditAnchor.name]: AuditAnchorJob;
  [JOB_QUEUES.evidenceSeal.name]: EvidenceSealJob;
  [JOB_QUEUES.auditVerify.name]: ChecksJob;
  [JOB_QUEUES.auditRotate.name]: ChecksJob;
  [JOB_QUEUES.gwgExpiry.name]: ChecksJob;
  [JOB_QUEUES.invoiceOverdue.name]: ChecksJob;
  [JOB_QUEUES.taxDeadlineMaterialize.name]: ChecksJob;
  [JOB_QUEUES.taxNewsFetch.name]: ChecksJob;
  [JOB_QUEUES.remindersDaily.name]: ChecksJob;
  [JOB_QUEUES.magicLinkCleanup.name]: ChecksJob;
  [JOB_QUEUES.dsgvoRetention.name]: ChecksJob;
  [JOB_QUEUES.poaExpiry.name]: ChecksJob;
  [JOB_QUEUES.backupRun.name]: ChecksJob;
  [JOB_QUEUES.backupDrill.name]: ChecksJob;
  [JOB_QUEUES.healthAlert.name]: ChecksJob;
  [JOB_QUEUES.updateCheck.name]: EmptyJob;
  [JOB_QUEUES.fidoMdsRefresh.name]: EmptyJob;
  [JOB_QUEUES.n8nDeliver.name]: N8nDeliverJob;
  [JOB_QUEUES.n8nOutboxReconcile.name]: EmptyJob;
  [JOB_QUEUES.workflowN8nDispatch.name]: EmptyJob;
  [JOB_QUEUES.workflowFeedback.name]: EmptyJob;
  [JOB_QUEUES.workflowAutoResume.name]: EmptyJob;
  [JOB_QUEUES.storageOrphanCleanup.name]: EmptyJob;
  [JOB_QUEUES.portalInboxCleanup.name]: EmptyJob;
  [JOB_QUEUES.n8nRetention.name]: EmptyJob;
  [JOB_QUEUES.riskAnalyseLlm.name]: RiskAnalyseLlmJob;
  [JOB_QUEUES.reminderDoneNotify.name]: ReminderDoneNotifyJob;
  [JOB_QUEUES.mailOutboxDeliver.name]: EmptyJob;
};

type AssertTrue<T extends true> = T;
/** R-13: a queue added to JOB_QUEUES without a data contract fails type checking. */
export type QueueJobDataComplete = AssertTrue<
  [Exclude<QueueName, keyof QueueJobDataByName>] extends [never] ? true : false
>;

/** Job data contract of a queue, addressed by its JOB_QUEUES key. */
export type QueueJobDataByKey<K extends JobQueueKey> =
  QueueJobDataByName[(typeof JOB_QUEUES)[K]['name']];

export interface QueueHealthDefinition {
  name: QueueName;
  expectedMaxGapMs: number | null;
  staleAfterMs: number | null;
}

const MINIMUM_STALE_AFTER_MS = 30 * SECOND;

/**
 * Health windows are derived from the same repeat definitions used by the
 * worker. A 50% grace period absorbs normal scheduler/worker latency; very
 * frequent queues get at least 30 seconds to avoid noisy transient alarms.
 */
export const QUEUE_HEALTH: readonly QueueHealthDefinition[] = Object.freeze(
  Object.values(JOB_QUEUES).map((queue) => {
    const expectedMaxGapMs = queue.schedule?.expectedMaxGapMs ?? null;
    return Object.freeze({
      name: queue.name,
      expectedMaxGapMs,
      staleAfterMs:
        expectedMaxGapMs == null ? null : Math.max(MINIMUM_STALE_AFTER_MS, expectedMaxGapMs * 1.5),
    });
  }),
);

/**
 * Completed and failed jobs must outlive the largest health window. Otherwise
 * a weekly or monthly queue loses its only diagnostic marker before the
 * operations UI can decide whether that run is actually overdue. Count caps
 * still bound busy queues independently of this age limit.
 */
export const QUEUE_STATUS_HISTORY_RETENTION_SECONDS = (60 * DAY) / SECOND;

const TIME_ZONE_LABELS: Readonly<Record<ScheduleTimeZone, string>> = {
  UTC: 'UTC',
  'Europe/Berlin': 'Berlin',
};

function describeEvery(ms: number): string {
  if (ms % HOUR === 0) return `every ${ms / HOUR} h`;
  if (ms % MINUTE === 0) return `every ${ms / MINUTE} min`;
  return `every ${ms / SECOND} sec`;
}

function clock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** Human description of the cron forms used in JOB_QUEUES; anything else stays verbatim. */
function describePattern(pattern: string, tz: ScheduleTimeZone): string {
  const zone = TIME_ZONE_LABELS[tz];
  const [minute, hour, dayOfMonth, month, dayOfWeek, ...rest] = pattern.split(' ');
  const fixedMinute = /^\d{1,2}$/.test(minute ?? '') ? Number(minute) : null;
  if (fixedMinute != null && month === '*' && rest.length === 0) {
    if (/^\d{1,2}$/.test(hour ?? '')) {
      const at = `${clock(Number(hour), fixedMinute)} ${zone}`;
      if (dayOfMonth === '*' && dayOfWeek === '*') return `${at} daily`;
      if (dayOfMonth === '*' && dayOfWeek === '0') return `${at} sundays`;
      if (dayOfMonth === '1' && dayOfWeek === '*') return `${at} 1st of month`;
    }
    const range = /^(\d{1,2})-(\d{1,2})\/(\d{1,2})$/.exec(hour ?? '');
    if (range && dayOfMonth === '*' && dayOfWeek === '*') {
      const [first, last, step] = range.slice(1).map(Number) as [number, number, number];
      const lastRun = first + Math.floor((last - first) / step) * step;
      return `every ${step} h, ${clock(first, fixedMinute)}-${clock(lastRun, fixedMinute)} ${zone}`;
    }
  }
  return `cron "${pattern}" ${zone}`;
}

/**
 * F-17: log label of a scheduled queue, derived from its repeat definition so the
 * displayed time and time zone cannot drift from what the scheduler registers.
 */
export function scheduleLogLabel(name: string, schedule: QueueScheduleDefinition): string {
  const { repeat } = schedule;
  const timing =
    'every' in repeat ? describeEvery(repeat.every) : describePattern(repeat.pattern, repeat.tz);
  return `${name} @ ${timing}${schedule.labelNote ? `, ${schedule.labelNote}` : ''}`;
}

export const SCHEDULE_LOG_LABELS: readonly string[] = Object.freeze(
  Object.values(JOB_QUEUES).flatMap((queue) => {
    const schedule: QueueScheduleDefinition | null = queue.schedule;
    return schedule == null ? [] : [scheduleLogLabel(queue.name, schedule)];
  }),
);
