// =============================================================================
// BullMQ-Queues
//
// Queues:
//   - evidence-seal: tägliche RFC-3161-Versiegelung
//   - gwg-expiry-check: täglich, schreibt Notifications für ablaufende GwG
//   - invoice-overdue-check: täglich, OVERDUE-Status + Notifications
//   - audit-verify-check: täglich, prüft Hash-Chain-Integrität
//
// RF-3: die virus-scan-Queue ist entfernt — sie hatte keinen Producer im Repo
// und der Job duplizierte die (inzwischen nur in @taxtronik/storage gefixte)
// ClamAV-Scan-Logik. Der synchrone Scan in packages/storage/src/service.ts
// ist der einzige Scan-Pfad.
// =============================================================================

import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '@taxtronik/config';
import {
  JOB_QUEUES,
  QUEUE_STATUS_HISTORY_RETENTION_SECONDS,
  type AuditAnchorJob,
  type ChecksJob,
  type EvidenceSealJob,
  type N8nDeliverJob,
  type RiskAnalyseLlmJob,
} from '@taxtronik/config/job-queues';

export type {
  AuditAnchorJob,
  ChecksJob,
  EvidenceSealJob,
  N8nDeliverJob,
  ReminderDoneNotifyJob,
  RiskAnalyseLlmJob,
} from '@taxtronik/config/job-queues';

const redisUrl = env.REDIS_URL;

export const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
});

// P2-16: abgeschlossene/fehlgeschlagene Jobs nicht unbegrenzt in Redis halten.
// Ohne das wachsen die Job-Hashes (u. a. health-alert/outbox-reconcile alle
// 5 min) monoton — Redis ohne maxmemory läuft langfristig voll. Per-Job-Options
// (z. B. n8n-deliver) überschreiben diese Defaults weiterhin.
const defaultJobOptions = {
  // The Ops UI uses the latest completed job for stale detection. Keep that
  // marker beyond the monthly backup-drill health window; count still bounds
  // high-frequency queues such as audit-anchor.
  removeOnComplete: { age: QUEUE_STATUS_HISTORY_RETENTION_SECONDS, count: 500 },
  removeOnFail: { age: QUEUE_STATUS_HISTORY_RETENTION_SECONDS, count: 500 },
} as const;

export const mailboxPollQueue = new Queue<ChecksJob, void, string>(JOB_QUEUES.mailboxPoll.name, {
  connection,
  defaultJobOptions,
});
export const sanctionsRefreshQueue = new Queue<ChecksJob, void, string>(
  JOB_QUEUES.sanctionsRefresh.name,
  { connection, defaultJobOptions },
);

export const evidenceSealQueue = new Queue<EvidenceSealJob, void, string>(
  JOB_QUEUES.evidenceSeal.name,
  { connection, defaultJobOptions },
);
export const auditAnchorQueue = new Queue<AuditAnchorJob, void, string>(
  JOB_QUEUES.auditAnchor.name,
  { connection, defaultJobOptions },
);
export const gwgExpiryQueue = new Queue<ChecksJob, void, string>(JOB_QUEUES.gwgExpiry.name, {
  connection,
  defaultJobOptions,
});
export const invoiceOverdueQueue = new Queue<ChecksJob, void, string>(
  JOB_QUEUES.invoiceOverdue.name,
  { connection, defaultJobOptions },
);
export const auditVerifyQueue = new Queue<ChecksJob, void, string>(JOB_QUEUES.auditVerify.name, {
  connection,
  defaultJobOptions,
});
export const taxDeadlineMaterializeQueue = new Queue<ChecksJob, void, string>(
  JOB_QUEUES.taxDeadlineMaterialize.name,
  { connection, defaultJobOptions },
);
export const auditRotateQueue = new Queue<ChecksJob, void, string>(JOB_QUEUES.auditRotate.name, {
  connection,
  defaultJobOptions,
});
export const taxNewsFetchQueue = new Queue<ChecksJob, void, string>(JOB_QUEUES.taxNewsFetch.name, {
  connection,
  defaultJobOptions,
});
export const remindersDailyQueue = new Queue<ChecksJob, void, string>(
  JOB_QUEUES.remindersDaily.name,
  {
    connection,
    defaultJobOptions,
  },
);
export const n8nDeliverQueue = new Queue<N8nDeliverJob, void, string>(JOB_QUEUES.n8nDeliver.name, {
  connection,
  defaultJobOptions,
});
export const n8nOutboxReconcileQueue = new Queue<Record<string, never>, void, string>(
  JOB_QUEUES.n8nOutboxReconcile.name,
  { connection, defaultJobOptions },
);
export const n8nRetentionQueue = new Queue<Record<string, never>, void, string>(
  JOB_QUEUES.n8nRetention.name,
  {
    connection,
    defaultJobOptions,
  },
);
export const workflowN8nDispatchQueue = new Queue<Record<string, never>, void, string>(
  JOB_QUEUES.workflowN8nDispatch.name,
  { connection, defaultJobOptions },
);
export const workflowFeedbackQueue = new Queue<Record<string, never>, void, string>(
  JOB_QUEUES.workflowFeedback.name,
  { connection, defaultJobOptions },
);
export const storageOrphanCleanupQueue = new Queue<Record<string, never>, void, string>(
  JOB_QUEUES.storageOrphanCleanup.name,
  { connection, defaultJobOptions },
);
export const portalInboxCleanupQueue = new Queue<Record<string, never>, void, string>(
  JOB_QUEUES.portalInboxCleanup.name,
  { connection, defaultJobOptions },
);
export const magicLinkCleanupQueue = new Queue<ChecksJob, void, string>(
  JOB_QUEUES.magicLinkCleanup.name,
  {
    connection,
    defaultJobOptions,
  },
);
export const dsgvoRetentionQueue = new Queue<ChecksJob, void, string>(
  JOB_QUEUES.dsgvoRetention.name,
  {
    connection,
    defaultJobOptions,
  },
);
export const poaExpiryQueue = new Queue<ChecksJob, void, string>(JOB_QUEUES.poaExpiry.name, {
  connection,
  defaultJobOptions,
});
export const riskAnalyseLlmQueue = new Queue<RiskAnalyseLlmJob, void, string>(
  JOB_QUEUES.riskAnalyseLlm.name,
  {
    connection,
    defaultJobOptions,
  },
);
export const backupDrillQueue = new Queue<ChecksJob, void, string>(JOB_QUEUES.backupDrill.name, {
  connection,
  defaultJobOptions,
});
export const backupRunQueue = new Queue<ChecksJob, void, string>(JOB_QUEUES.backupRun.name, {
  connection,
  defaultJobOptions,
});
export const healthAlertQueue = new Queue<ChecksJob, void, string>(JOB_QUEUES.healthAlert.name, {
  connection,
  defaultJobOptions,
});

// RF-3/RF-13: die QueueEvents-Instanzen (virus-scan, evidence-seal) sind
// entfernt — sie hatten keinerlei Consumer und wurden beim Shutdown nie
// geschlossen (offene Redis-Subscriptions).
