// =============================================================================
// BullMQ-Queue für manuell ausgelöste tax-deadline-materialize-Jobs
// („Neu berechnen" auf /staff/tax-deadlines).
//
// Singleton-Pattern analog zu audit-rotate-queue.ts. Die tenant-weite
// Materialisierung gehört nicht in eine interaktive 15-s-Server-Action-Tx
// (P2028 bei vielen Mandanten) — der Worker-Job tax-deadline-materialize
// übernimmt sie im Hintergrund.
// =============================================================================

import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { env } from '@taxtronik/config';
import { log } from '@/server/logger';

import { withTimeout } from '@/lib/with-timeout';

/**
 * BullMQ-Connections laufen bewusst mit `maxRetriesPerRequest: null`. Faellt
 * Redis aus, parkt ioredis den Befehl dann in der Offline-Queue und das Promise
 * resolved NIE — der aufrufende Pfad haengt. Deckelung wie in n8n/outbox.ts.
 */
const QUEUE_TIMEOUT_MS = 2_000;

interface TaxDeadlineMaterializeJob {
  tenantId: string;
}

declare global {
  // `var` is intentional for ambient globalThis augmentation.
  // noinspection ES6ConvertVarToLetConst
  var __taxtronik_tax_deadline_materialize_queue:
    | { conn: IORedis; queue: Queue<TaxDeadlineMaterializeJob> }
    | undefined;
}

function init(): { conn: IORedis; queue: Queue<TaxDeadlineMaterializeJob> } {
  const conn = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  conn.on('error', (err) => {
    log.warn({ component: 'tax-deadline-materialize-queue', err: err.message }, 'redis error');
  });
  const queue = new Queue<TaxDeadlineMaterializeJob>('tax-deadline-materialize', {
    connection: conn,
  });
  return { conn, queue };
}

function getHandle(): { conn: IORedis; queue: Queue<TaxDeadlineMaterializeJob> } {
  const existing = globalThis.__taxtronik_tax_deadline_materialize_queue;
  if (existing) return existing;

  const handle = init();
  // IMMER cachen — nicht nur im Dev: sonst leakt in Produktion jeder Aufruf
  // eine neue IORedis-Connection (bis Redis maxclients erschöpft ist).
  globalThis.__taxtronik_tax_deadline_materialize_queue = handle;
  return handle;
}

/** Reiht die Materialisierung für EINEN Tenant ein. Idempotent über jobId. */
export async function enqueueTaxDeadlineMaterialize(tenantId: string): Promise<void> {
  const { queue } = getHandle();
  // BullMQ verbietet ':' in Custom-Job-IDs — daher '-'. Mehrfach-Klicks während
  // ein Lauf aussteht sind No-Ops (ID existiert); alte Jobs vorher räumen.
  const jobId = `tax-deadline-manual-${tenantId}`;
  await withTimeout(queue.remove(jobId), QUEUE_TIMEOUT_MS).catch(() => {});
  await withTimeout(
    queue.add(
      'tax-deadline-materialize',
      { tenantId },
      {
        jobId,
        // Persistierte Auto-Request-Benachrichtigungen duerfen bei einem
        // eindeutig technischen Fehlschlag maximal dreimal versucht werden.
        // UNKNOWN/Teilversand/kein Empfaenger werden vom Worker terminal
        // eskaliert und loesen keinen BullMQ-Retry aus.
        attempts: 3,
        backoff: { type: 'exponential', delay: 5 * 60_000 },
        removeOnComplete: 20,
        removeOnFail: 20,
      },
    ),
    QUEUE_TIMEOUT_MS,
  );
}
