// =============================================================================
// Worker-Registry: genau ein BullMQ-Worker je JOB_QUEUES-Eintrag.
//
// R-13: Ready-Log und Shutdown (index.ts) iterieren über JOB_QUEUES statt über
// eine handgepflegte Liste. `satisfies` erzwingt zur Compile-Zeit, dass jeder
// Queue-Schlüssel einen Worker hat (und kein unbekannter dazukommt);
// buildWorkerRegistry prüft beim Start, dass jeder Worker tatsächlich die Queue
// seines Schlüssels konsumiert.
// =============================================================================

import type { Worker } from 'bullmq';
import { JOB_QUEUES, JOB_QUEUE_KEYS, type JobQueueKey } from '@taxtronik/config/job-queues';
import { evidenceSealWorker } from './jobs/evidence-seal';
import { auditAnchorWorker } from './jobs/audit-anchor';
import { gwgExpiryWorker } from './jobs/gwg-expiry-check';
import { invoiceOverdueWorker } from './jobs/invoice-overdue-check';
import { auditVerifyWorker } from './jobs/audit-verify-check';
import { taxDeadlineMaterializeWorker } from './jobs/tax-deadline-materialize';
import { auditRotateWorker } from './jobs/audit-rotate';
import { taxNewsFetchWorker } from './jobs/tax-news-fetch';
import { remindersDailyWorker } from './jobs/reminders-daily';
import { n8nDeliverWorker, n8nOutboxReconcileWorker } from './jobs/n8n-deliver';
import { n8nRetentionWorker } from './jobs/n8n-retention';
import { magicLinkCleanupWorker } from './jobs/magic-link-cleanup';
import { dsgvoRetentionWorker } from './jobs/dsgvo-retention';
import { poaExpiryWorker } from './jobs/poa-expiry-check';
import { riskAnalyseLlmWorker } from './jobs/risk-analyse-llm';
import { reminderDoneNotifyWorker } from './jobs/reminder-done-notify';
import { backupDrillWorker } from './jobs/backup-drill';
import { backupRunWorker } from './jobs/backup-run';
import { healthAlertWorker } from './jobs/health-alert';
import { workflowN8nDispatchWorker } from './jobs/workflow-n8n-dispatch';
import { workflowFeedbackWorker } from './jobs/workflow-feedback';
import { workflowAutoResumeWorker } from './jobs/workflow-auto-resume';
import { storageOrphanCleanupWorker } from './jobs/storage-orphan-cleanup';
import { portalInboxCleanupWorker } from './jobs/portal-inbox-cleanup';
import { mailboxPollWorker, sanctionsRefreshWorker } from './jobs/expansion';

/** Minimal shape the registry needs; real entries are BullMQ workers. */
export interface RegisteredWorker {
  readonly name: string;
}

const WORKERS_BY_QUEUE = {
  mailboxPoll: mailboxPollWorker,
  sanctionsRefresh: sanctionsRefreshWorker,
  auditAnchor: auditAnchorWorker,
  evidenceSeal: evidenceSealWorker,
  auditVerify: auditVerifyWorker,
  auditRotate: auditRotateWorker,
  gwgExpiry: gwgExpiryWorker,
  invoiceOverdue: invoiceOverdueWorker,
  taxDeadlineMaterialize: taxDeadlineMaterializeWorker,
  taxNewsFetch: taxNewsFetchWorker,
  remindersDaily: remindersDailyWorker,
  magicLinkCleanup: magicLinkCleanupWorker,
  dsgvoRetention: dsgvoRetentionWorker,
  poaExpiry: poaExpiryWorker,
  backupRun: backupRunWorker,
  backupDrill: backupDrillWorker,
  healthAlert: healthAlertWorker,
  n8nDeliver: n8nDeliverWorker,
  n8nOutboxReconcile: n8nOutboxReconcileWorker,
  workflowN8nDispatch: workflowN8nDispatchWorker,
  workflowFeedback: workflowFeedbackWorker,
  workflowAutoResume: workflowAutoResumeWorker,
  storageOrphanCleanup: storageOrphanCleanupWorker,
  portalInboxCleanup: portalInboxCleanupWorker,
  n8nRetention: n8nRetentionWorker,
  riskAnalyseLlm: riskAnalyseLlmWorker,
  reminderDoneNotify: reminderDoneNotifyWorker,
} satisfies Record<JobQueueKey, Worker>;

/**
 * Ordnet die Worker in JOB_QUEUES-Reihenfolge und bricht ab, wenn ein Worker
 * nicht die Queue seines Schlüssels konsumiert.
 */
export function buildWorkerRegistry<W extends RegisteredWorker>(
  byQueue: Readonly<Record<JobQueueKey, W>>,
): readonly W[] {
  return Object.freeze(
    JOB_QUEUE_KEYS.map((key) => {
      const worker = byQueue[key];
      const expected = JOB_QUEUES[key].name;
      if (worker?.name !== expected) {
        throw new Error(
          `worker-registry: ${key} erwartet Queue "${expected}", registriert ist "${worker?.name}".`,
        );
      }
      return worker;
    }),
  );
}

/** Alle Worker des Prozesses; `.name` ist der Queue-Name. */
export const ALL_WORKERS: readonly Worker[] = buildWorkerRegistry<Worker>(WORKERS_BY_QUEUE);
