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

const redisUrl = env.REDIS_URL;

export const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
});

export interface EvidenceSealJob {
  tenantId?: string;
  sealDate?: string;
}

export interface ChecksJob {
  // optional: nur einen Tenant prüfen (für Manual-Trigger)
  tenantId?: string;
  // optional: Mitarbeiter, der den manuellen Check ausgelöst hat.
  requestedByStaffId?: string;
}

export interface N8nDeliverJob {
  outboxId: string;
}

export interface RiskAnalyseLlmJob {
  tenantId: string;
  analysisId: string;
  /** Der bereits analysierte Sachverhalt — die Engine ist zustandslos. */
  sourceText: string;
  optionen?: Record<string, unknown>;
}

export const evidenceSealQueue = new Queue<EvidenceSealJob, void, string>('evidence-seal', { connection });
export const gwgExpiryQueue = new Queue<ChecksJob, void, string>('gwg-expiry-check', { connection });
export const invoiceOverdueQueue = new Queue<ChecksJob, void, string>('invoice-overdue-check', { connection });
export const auditVerifyQueue = new Queue<ChecksJob, void, string>('audit-verify-check', { connection });
export const taxDeadlineMaterializeQueue = new Queue<ChecksJob, void, string>('tax-deadline-materialize', { connection });
export const auditRotateQueue = new Queue<ChecksJob, void, string>('audit-rotate', { connection });
export const taxNewsFetchQueue = new Queue<ChecksJob, void, string>('tax-news-fetch', { connection });
export const remindersDailyQueue = new Queue<ChecksJob, void, string>('reminders-daily', { connection });
export const n8nDeliverQueue = new Queue<N8nDeliverJob, void, string>('n8n-deliver', { connection });
export const n8nOutboxReconcileQueue = new Queue<Record<string, never>, void, string>('n8n-outbox-reconcile', { connection });
export const magicLinkCleanupQueue = new Queue<ChecksJob, void, string>('magic-link-cleanup', { connection });
export const dsgvoRetentionQueue = new Queue<ChecksJob, void, string>('dsgvo-retention', { connection });
export const poaExpiryQueue = new Queue<ChecksJob, void, string>('poa-expiry-check', { connection });
export const riskAnalyseLlmQueue = new Queue<RiskAnalyseLlmJob, void, string>('risk-analyse-llm', { connection });
export const backupDrillQueue = new Queue<ChecksJob, void, string>('backup-drill', { connection });
export const healthAlertQueue = new Queue<ChecksJob, void, string>('health-alert', { connection });

// RF-3/RF-13: die QueueEvents-Instanzen (virus-scan, evidence-seal) sind
// entfernt — sie hatten keinerlei Consumer und wurden beim Shutdown nie
// geschlossen (offene Redis-Subscriptions).
