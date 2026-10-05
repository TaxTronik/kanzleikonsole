// =============================================================================
// BullMQ-Queues des Workers
//
// R-13: Für jeden Eintrag in JOB_QUEUES (@taxtronik/config/job-queues) entsteht
// genau eine Producer-Queue — gleicher Name, gleiche Default-Job-Options. Eine
// neue Queue braucht hier keine Änderung mehr; Scheduler (scheduler.ts) und
// Worker-Registry (worker-registry.ts) leiten sich ebenfalls aus JOB_QUEUES ab.
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
  JOB_QUEUE_KEYS,
  QUEUE_STATUS_HISTORY_RETENTION_SECONDS,
  type JobQueueKey,
  type QueueJobDataByKey,
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

/** Producer-Queue eines JOB_QUEUES-Eintrags, typisiert mit dessen Job-Daten. */
export type WorkerQueue<K extends JobQueueKey> = Queue<QueueJobDataByKey<K>, void, string>;
export type WorkerQueues = { readonly [K in JobQueueKey]: WorkerQueue<K> };

function createQueues(): WorkerQueues {
  const created: Partial<Record<JobQueueKey, Queue<unknown, void, string>>> = {};
  for (const key of JOB_QUEUE_KEYS) {
    created[key] = new Queue<unknown, void, string>(JOB_QUEUES[key].name, {
      connection,
      defaultJobOptions,
    });
  }
  return Object.freeze(created) as WorkerQueues;
}

/** Eine Queue je JOB_QUEUES-Schlüssel, in der Reihenfolge von JOB_QUEUES. */
export const queues: WorkerQueues = createQueues();

// RF-3/RF-13: die QueueEvents-Instanzen (virus-scan, evidence-seal) sind
// entfernt — sie hatten keinerlei Consumer und wurden beim Shutdown nie
// geschlossen (offene Redis-Subscriptions).
