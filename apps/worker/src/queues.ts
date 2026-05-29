// =============================================================================
// BullMQ-Queues
//
// Queues:
//   - virus-scan: asynchrone ClamAV-Prüfung (Fallback)
//   - evidence-seal: tägliche RFC-3161-Versiegelung
//   - gwg-expiry-check: täglich, schreibt Notifications für ablaufende GwG
//   - invoice-overdue-check: täglich, OVERDUE-Status + Notifications
//   - audit-verify-check: täglich, prüft Hash-Chain-Integrität
// =============================================================================

import { Queue, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '@taxtronik/config';

const redisUrl = env.REDIS_URL;

export const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
});

export interface VirusScanJob {
  tenantId: string;
  documentVersionId: string;
  bucket: string;
  storageKey: string;
}

export interface EvidenceSealJob {
  tenantId?: string;
  sealDate?: string;
}

export interface ChecksJob {
  // optional: nur einen Tenant prüfen (für Manual-Trigger)
  tenantId?: string;
}

export interface N8nDeliverJob {
  outboxId: string;
}

export const virusScanQueue = new Queue<VirusScanJob, void, string>('virus-scan', { connection });
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

export const virusScanEvents = new QueueEvents('virus-scan', { connection });
export const evidenceSealEvents = new QueueEvents('evidence-seal', { connection });
