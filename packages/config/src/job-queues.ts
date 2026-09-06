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

export interface QueueScheduleDefinition {
  schedulerId: string;
  repeat: Readonly<
    | { every: number }
    | {
        pattern: string;
        tz?: string;
      }
  >;
  /** Longest normal gap between two scheduled runs (cron windows included). */
  expectedMaxGapMs: number;
  logLabel: string;
}

interface QueueDefinition {
  name: string;
  schedule: QueueScheduleDefinition | null;
}

const BERLIN = 'Europe/Berlin';

/**
 * All queues consumed by the worker. Object order is the display order used by
 * the operations page and by the scheduler registration log.
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
      expectedMaxGapMs: DAY,
      logLabel: 'sanctions-refresh @ 05:15 Berlin daily',
    },
  },
  auditAnchor: {
    name: 'audit-anchor',
    schedule: {
      schedulerId: 'rolling-audit-anchor',
      repeat: { every: 2 * SECOND },
      expectedMaxGapMs: 2 * SECOND,
      logLabel: 'audit-anchor @ every 2 sec',
    },
  },
  evidenceSeal: {
    name: 'evidence-seal',
    schedule: {
      schedulerId: 'daily-seal',
      repeat: { pattern: '30 2 * * *' },
      expectedMaxGapMs: DAY,
      logLabel: 'evidence-seal @ 02:30 UTC daily',
    },
  },
  auditVerify: {
    name: 'audit-verify-check',
    schedule: {
      schedulerId: 'daily-audit-verify',
      repeat: { pattern: '45 2 * * *' },
      expectedMaxGapMs: DAY,
      logLabel: 'audit-verify-check @ 02:45 UTC daily',
    },
  },
  auditRotate: {
    name: 'audit-rotate',
    schedule: {
      schedulerId: 'weekly-audit-rotate',
      repeat: { pattern: '0 3 * * 0' },
      expectedMaxGapMs: 7 * DAY,
      logLabel: 'audit-rotate @ 03:00 UTC sundays',
    },
  },
  gwgExpiry: {
    name: 'gwg-expiry-check',
    schedule: {
      schedulerId: 'daily-gwg-expiry',
      repeat: { pattern: '0 7 * * *', tz: BERLIN },
      expectedMaxGapMs: DAY,
      logLabel: 'gwg-expiry-check @ 07:00 Berlin daily',
    },
  },
  invoiceOverdue: {
    name: 'invoice-overdue-check',
    schedule: {
      schedulerId: 'daily-invoice-overdue',
      repeat: { pattern: '15 7 * * *', tz: BERLIN },
      expectedMaxGapMs: DAY,
      logLabel: 'invoice-overdue-check @ 07:15 Berlin daily',
    },
  },
  taxDeadlineMaterialize: {
    name: 'tax-deadline-materialize',
    schedule: {
      schedulerId: 'daily-tax-deadline-materialize',
      repeat: { pattern: '30 7 * * *', tz: BERLIN },
      expectedMaxGapMs: DAY,
      logLabel: 'tax-deadline-materialize @ 07:30 Berlin daily',
    },
  },
  taxNewsFetch: {
    name: 'tax-news-fetch',
    schedule: {
      // Keep the existing ID: upsert replaces the former schedule in-place.
      schedulerId: 'daily-tax-news-fetch',
      repeat: { pattern: '30 6-20/2 * * *', tz: BERLIN },
      // 20:30 to 06:30 is the longest intentional overnight pause.
      expectedMaxGapMs: 10 * HOUR,
      logLabel: 'tax-news-fetch @ every 2 h, 06:30-20:30 Berlin',
    },
  },
  remindersDaily: {
    name: 'reminders-daily',
    schedule: {
      schedulerId: 'daily-reminders',
      repeat: { pattern: '45 7 * * *', tz: BERLIN },
      expectedMaxGapMs: DAY,
      logLabel: 'reminders-daily @ 07:45 Berlin daily',
    },
  },
  magicLinkCleanup: {
    name: 'magic-link-cleanup',
    schedule: {
      schedulerId: 'daily-magic-link-cleanup',
      repeat: { pattern: '30 3 * * *' },
      expectedMaxGapMs: DAY,
      logLabel: 'magic-link-cleanup @ 03:30 UTC daily',
    },
  },
  dsgvoRetention: {
    name: 'dsgvo-retention',
    schedule: {
      schedulerId: 'daily-dsgvo-retention',
      repeat: { pattern: '0 4 * * *' },
      expectedMaxGapMs: DAY,
      logLabel: 'dsgvo-retention @ 04:00 UTC daily',
    },
  },
  poaExpiry: {
    name: 'poa-expiry-check',
    schedule: {
      schedulerId: 'daily-poa-expiry',
      repeat: { pattern: '20 7 * * *', tz: BERLIN },
      expectedMaxGapMs: DAY,
      logLabel: 'poa-expiry-check @ 07:20 Berlin daily',
    },
  },
  backupRun: {
    name: 'backup-run',
    schedule: {
      schedulerId: 'daily-backup-run',
      repeat: { pattern: '0 1 * * *' },
      expectedMaxGapMs: DAY,
      logLabel: 'backup-run @ 01:00 UTC daily',
    },
  },
  backupDrill: {
    name: 'backup-drill',
    schedule: {
      schedulerId: 'monthly-backup-drill',
      repeat: { pattern: '0 5 1 * *' },
      expectedMaxGapMs: 31 * DAY,
      logLabel: 'backup-drill @ 05:00 UTC 1st of month',
    },
  },
  healthAlert: {
    name: 'health-alert',
    schedule: {
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
      schedulerId: 'n8n-outbox-reconcile',
      repeat: { every: 5 * MINUTE },
      expectedMaxGapMs: 5 * MINUTE,
      logLabel: 'n8n-outbox-reconcile @ every 5 min',
    },
  },
  workflowN8nDispatch: {
    name: 'workflow-n8n-dispatch',
    schedule: {
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
      expectedMaxGapMs: 6 * HOUR,
      logLabel: 'storage-orphan-cleanup @ every 6 h',
    },
  },
  portalInboxCleanup: {
    name: 'portal-inbox-cleanup',
    schedule: {
      schedulerId: 'portal-inbox-cleanup',
      repeat: { every: 6 * HOUR },
      expectedMaxGapMs: 6 * HOUR,
      logLabel: 'portal-inbox-cleanup @ every 6 h',
    },
  },
  n8nRetention: {
    name: 'n8n-retention',
    schedule: {
      schedulerId: 'daily-n8n-retention',
      repeat: { pattern: '45 3 * * *' },
      expectedMaxGapMs: DAY,
      logLabel: 'n8n-retention @ 03:45 UTC daily',
    },
  },
  riskAnalyseLlm: { name: 'risk-analyse-llm', schedule: null },
  reminderDoneNotify: { name: 'reminder-done-notify', schedule: null },
} as const satisfies Record<string, QueueDefinition>;

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
