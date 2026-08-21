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

// P2-16: abgeschlossene/fehlgeschlagene Jobs nicht unbegrenzt in Redis halten.
// Ohne das wachsen die Job-Hashes (u. a. health-alert/outbox-reconcile alle
// 5 min) monoton — Redis ohne maxmemory läuft langfristig voll. Per-Job-Options
// (z. B. n8n-deliver) überschreiben diese Defaults weiterhin.
const defaultJobOptions = {
  removeOnComplete: { age: 24 * 60 * 60, count: 500 },
  removeOnFail: { age: 7 * 24 * 60 * 60 },
} as const;

export interface EvidenceSealJob {
  tenantId?: string;
  sealDate?: string;
}

export interface AuditAnchorJob {
  /** Omit for the frequent global reconciliation tick. */
  tenantId?: string;
}

export interface ChecksJob {
  // optional: nur einen Tenant prüfen (für Manual-Trigger)
  tenantId?: string;
  // optional: Mitarbeiter, der den manuellen Check ausgelöst hat.
  requestedByStaffId?: string;
  requestId?: string;
}

/** Neue Jobs adressieren eine Delivery; outboxId toleriert bereits liegende Altjobs. */
export type N8nDeliverJob =
  | { deliveryId: string; outboxId?: never }
  | { outboxId: string; deliveryId?: never };

/** Verzögerte „Wiedervorlage erledigt"-Rückmeldung an die delegierende Person. */
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
  /** Der bereits analysierte Sachverhalt — die Engine ist zustandslos. */
  sourceText: string;
  optionen?: Record<string, unknown>;
}

export const evidenceSealQueue = new Queue<EvidenceSealJob, void, string>('evidence-seal', {
  connection,
  defaultJobOptions,
});
export const auditAnchorQueue = new Queue<AuditAnchorJob, void, string>('audit-anchor', {
  connection,
  defaultJobOptions,
});
export const gwgExpiryQueue = new Queue<ChecksJob, void, string>('gwg-expiry-check', {
  connection,
  defaultJobOptions,
});
export const invoiceOverdueQueue = new Queue<ChecksJob, void, string>('invoice-overdue-check', {
  connection,
  defaultJobOptions,
});
export const auditVerifyQueue = new Queue<ChecksJob, void, string>('audit-verify-check', {
  connection,
  defaultJobOptions,
});
export const taxDeadlineMaterializeQueue = new Queue<ChecksJob, void, string>(
  'tax-deadline-materialize',
  { connection, defaultJobOptions },
);
export const auditRotateQueue = new Queue<ChecksJob, void, string>('audit-rotate', {
  connection,
  defaultJobOptions,
});
export const taxNewsFetchQueue = new Queue<ChecksJob, void, string>('tax-news-fetch', {
  connection,
  defaultJobOptions,
});
export const remindersDailyQueue = new Queue<ChecksJob, void, string>('reminders-daily', {
  connection,
  defaultJobOptions,
});
export const n8nDeliverQueue = new Queue<N8nDeliverJob, void, string>('n8n-deliver', {
  connection,
  defaultJobOptions,
});
export const n8nOutboxReconcileQueue = new Queue<Record<string, never>, void, string>(
  'n8n-outbox-reconcile',
  { connection, defaultJobOptions },
);
export const n8nRetentionQueue = new Queue<Record<string, never>, void, string>('n8n-retention', {
  connection,
  defaultJobOptions,
});
export const magicLinkCleanupQueue = new Queue<ChecksJob, void, string>('magic-link-cleanup', {
  connection,
  defaultJobOptions,
});
export const dsgvoRetentionQueue = new Queue<ChecksJob, void, string>('dsgvo-retention', {
  connection,
  defaultJobOptions,
});
export const poaExpiryQueue = new Queue<ChecksJob, void, string>('poa-expiry-check', {
  connection,
  defaultJobOptions,
});
export const riskAnalyseLlmQueue = new Queue<RiskAnalyseLlmJob, void, string>('risk-analyse-llm', {
  connection,
  defaultJobOptions,
});
export const backupDrillQueue = new Queue<ChecksJob, void, string>('backup-drill', {
  connection,
  defaultJobOptions,
});
export const backupRunQueue = new Queue<ChecksJob, void, string>('backup-run', {
  connection,
  defaultJobOptions,
});
export const healthAlertQueue = new Queue<ChecksJob, void, string>('health-alert', {
  connection,
  defaultJobOptions,
});

// RF-3/RF-13: die QueueEvents-Instanzen (virus-scan, evidence-seal) sind
// entfernt — sie hatten keinerlei Consumer und wurden beim Shutdown nie
// geschlossen (offene Redis-Subscriptions).
