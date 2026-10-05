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

export interface QueueScheduleDefinition {
  schedulerId: string;
  repeat: Readonly<
    | { every: number }
    | {
        pattern: string;
        tz?: string;
      }
  >;
  /** Retry policy of the scheduled runs; omitted = a single attempt. */
  jobOptions?: Readonly<ScheduledJobOptions>;
  /** Longest normal gap between two scheduled runs (cron windows included). */
  expectedMaxGapMs: number;
  logLabel: string;
}

interface QueueDefinition {
  name: string;
  schedule: QueueScheduleDefinition | null;
}

const BERLIN = 'Europe/Berlin';

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
      logLabel: 'mailbox-poll @ every 5 min',
    },
  },
  sanctionsRefresh: {
    name: 'sanctions-refresh',
    schedule: {
      schedulerId: 'daily-sanctions-refresh',
      repeat: { pattern: '15 5 * * *', tz: BERLIN },
      jobOptions: DAILY_RETRY,
      expectedMaxGapMs: DAY,
      logLabel: 'sanctions-refresh @ 05:15 Berlin daily',
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
      logLabel: 'audit-anchor @ every 2 sec, per tenant >= 60 sec unless invoice/gwg',
    },
  },
  evidenceSeal: {
    name: 'evidence-seal',
    schedule: {
      schedulerId: 'daily-seal',
      repeat: { pattern: '30 2 * * *' },
      // RF-2: Retries für den Versiegelungslauf — ein transienter Fehler
      // (TSA/DB kurz weg) soll nicht bis zum nächsten Kalendertag warten.
      // Verpasste Tage holt der Lauf ohnehin per Backfill nach.
      jobOptions: DAILY_RETRY,
      expectedMaxGapMs: DAY,
      logLabel: 'evidence-seal @ 02:30 UTC daily',
    },
  },
  auditVerify: {
    name: 'audit-verify-check',
    schedule: {
      schedulerId: 'daily-audit-verify',
      repeat: { pattern: '45 2 * * *' },
      jobOptions: DAILY_RETRY,
      expectedMaxGapMs: DAY,
      logLabel: 'audit-verify-check @ 02:45 UTC daily',
    },
  },
  auditRotate: {
    name: 'audit-rotate',
    schedule: {
      schedulerId: 'weekly-audit-rotate',
      repeat: { pattern: '0 3 * * 0' },
      jobOptions: DAILY_RETRY,
      expectedMaxGapMs: 7 * DAY,
      logLabel: 'audit-rotate @ 03:00 UTC sundays',
    },
  },
  gwgExpiry: {
    name: 'gwg-expiry-check',
    schedule: {
      schedulerId: 'daily-gwg-expiry',
      repeat: { pattern: '0 7 * * *', tz: BERLIN },
      jobOptions: DAILY_RETRY,
      expectedMaxGapMs: DAY,
      logLabel: 'gwg-expiry-check @ 07:00 Berlin daily',
    },
  },
  invoiceOverdue: {
    name: 'invoice-overdue-check',
    schedule: {
      schedulerId: 'daily-invoice-overdue',
      repeat: { pattern: '15 7 * * *', tz: BERLIN },
      jobOptions: DAILY_RETRY,
      expectedMaxGapMs: DAY,
      logLabel: 'invoice-overdue-check @ 07:15 Berlin daily',
    },
  },
  taxDeadlineMaterialize: {
    name: 'tax-deadline-materialize',
    schedule: {
      schedulerId: 'daily-tax-deadline-materialize',
      repeat: { pattern: '30 7 * * *', tz: BERLIN },
      jobOptions: DAILY_RETRY,
      expectedMaxGapMs: DAY,
      logLabel: 'tax-deadline-materialize @ 07:30 Berlin daily',
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
      logLabel: 'tax-news-fetch @ every 2 h, 06:30-20:30 Berlin',
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
      logLabel: 'reminders-daily @ 07:45 Berlin daily',
    },
  },
  magicLinkCleanup: {
    name: 'magic-link-cleanup',
    schedule: {
      // H6: Die Magic-Link-Tabelle wächst sonst unbegrenzt.
      schedulerId: 'daily-magic-link-cleanup',
      repeat: { pattern: '30 3 * * *' },
      jobOptions: DAILY_RETRY,
      expectedMaxGapMs: DAY,
      logLabel: 'magic-link-cleanup @ 03:30 UTC daily',
    },
  },
  dsgvoRetention: {
    name: 'dsgvo-retention',
    schedule: {
      // Löscht Notifications (>1J), Phone-Notes (>3J) und nullt
      // client_contact.lastLoginAt (>2J). Siehe dsgvo-konzept.md 2.2.
      schedulerId: 'daily-dsgvo-retention',
      repeat: { pattern: '0 4 * * *' },
      jobOptions: DAILY_RETRY,
      expectedMaxGapMs: DAY,
      logLabel: 'dsgvo-retention @ 04:00 UTC daily',
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
      logLabel: 'poa-expiry-check @ 07:20 Berlin daily',
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
      repeat: { pattern: '0 1 * * *' },
      jobOptions: BACKUP_RETRY,
      expectedMaxGapMs: DAY,
      logLabel: 'backup-run @ 01:00 UTC daily',
    },
  },
  backupDrill: {
    name: 'backup-drill',
    schedule: {
      // Restore-Drill: beweisbarer Wirksamkeitsnachweis der Sicherung
      // (Art. 32 DSGVO / GoBD).
      schedulerId: 'monthly-backup-drill',
      repeat: { pattern: '0 5 1 * *' },
      jobOptions: BACKUP_RETRY,
      expectedMaxGapMs: 31 * DAY,
      logLabel: 'backup-drill @ 05:00 UTC 1st of month',
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
      logLabel: 'health-alert @ every 5 min',
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
      logLabel: 'n8n-outbox-reconcile @ every 5 min',
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
      logLabel: 'workflow-n8n-dispatch @ every 1 min',
    },
  },
  workflowFeedback: {
    name: 'workflow-feedback',
    schedule: {
      schedulerId: 'workflow-feedback',
      repeat: { every: MINUTE },
      expectedMaxGapMs: MINUTE,
      logLabel: 'workflow-feedback @ every 1 min',
    },
  },
  storageOrphanCleanup: {
    name: 'storage-orphan-cleanup',
    schedule: {
      schedulerId: 'storage-orphan-cleanup',
      repeat: { every: 6 * HOUR },
      jobOptions: DAILY_RETRY,
      expectedMaxGapMs: 6 * HOUR,
      logLabel: 'storage-orphan-cleanup @ every 6 h',
    },
  },
  portalInboxCleanup: {
    name: 'portal-inbox-cleanup',
    schedule: {
      schedulerId: 'portal-inbox-cleanup',
      repeat: { every: 6 * HOUR },
      jobOptions: DAILY_RETRY,
      expectedMaxGapMs: 6 * HOUR,
      logLabel: 'portal-inbox-cleanup @ every 6 h',
    },
  },
  n8nRetention: {
    name: 'n8n-retention',
    schedule: {
      // Begrenzte n8n-Historie: normale Terminal-Events 90 Tage, Fehler/Partial
      // 180 Tage. Der Worker löscht nur weiterhin terminale Reihen in Batches.
      schedulerId: 'daily-n8n-retention',
      repeat: { pattern: '45 3 * * *' },
      jobOptions: DAILY_RETRY,
      expectedMaxGapMs: DAY,
      logLabel: 'n8n-retention @ 03:45 UTC daily',
    },
  },
  riskAnalyseLlm: { name: 'risk-analyse-llm', schedule: null },
  reminderDoneNotify: { name: 'reminder-done-notify', schedule: null },
} as const satisfies Record<string, QueueDefinition>;

export type JobQueueKey = keyof typeof JOB_QUEUES;

/** Keys of JOB_QUEUES in declaration (display/registration) order. */
export const JOB_QUEUE_KEYS: readonly JobQueueKey[] = Object.freeze(
  Object.keys(JOB_QUEUES) as JobQueueKey[],
);

export type QueueName = (typeof JOB_QUEUES)[keyof typeof JOB_QUEUES]['name'];

/**
 * P-05: Mindestabstand zwischen zwei Rolling-Ankern desselben Tenants. Der
 * 2-Sekunden-Takt bleibt, damit offene Rechnungs- und GwG-Ereignisse sofort
 * extern verankert werden; alle übrigen Einträge eines Tenants fasst höchstens
 * ein RFC-3161-Stempel je Intervall zusammen.
 */
export const AUDIT_ANCHOR_MIN_TENANT_INTERVAL_MS = MINUTE;

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

/** Delayed completion notification to the delegating staff member. */
export interface ReminderDoneNotifyJob {
  tenantId: string;
  reminderId: string;
  staffId: string;
  clientId: string | null;
  subject: string;
  doneByName: string;
}

export interface RiskAnalyseLlmJob {
  tenantId: string;
  analysisId: string;
  /** The already analysed facts; the engine itself is stateless. */
  sourceText: string;
  optionen?: Record<string, unknown>;
}

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
  [JOB_QUEUES.n8nDeliver.name]: N8nDeliverJob;
  [JOB_QUEUES.n8nOutboxReconcile.name]: EmptyJob;
  [JOB_QUEUES.workflowN8nDispatch.name]: EmptyJob;
  [JOB_QUEUES.workflowFeedback.name]: EmptyJob;
  [JOB_QUEUES.storageOrphanCleanup.name]: EmptyJob;
  [JOB_QUEUES.portalInboxCleanup.name]: EmptyJob;
  [JOB_QUEUES.n8nRetention.name]: EmptyJob;
  [JOB_QUEUES.riskAnalyseLlm.name]: RiskAnalyseLlmJob;
  [JOB_QUEUES.reminderDoneNotify.name]: ReminderDoneNotifyJob;
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

export const SCHEDULE_LOG_LABELS: readonly string[] = Object.freeze(
  Object.values(JOB_QUEUES).flatMap((queue) =>
    queue.schedule == null ? [] : [queue.schedule.logLabel],
  ),
);
