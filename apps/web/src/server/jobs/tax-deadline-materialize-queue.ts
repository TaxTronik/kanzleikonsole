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

interface TaxDeadlineMaterializeJob {
  tenantId: string;
}

declare global {
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
  if (env.NODE_ENV !== 'production') {
    globalThis.__taxtronik_tax_deadline_materialize_queue = handle;
  }
  return handle;
}

/** Reiht die Materialisierung für EINEN Tenant ein. Idempotent über jobId. */
export async function enqueueTaxDeadlineMaterialize(tenantId: string): Promise<void> {
  const { queue } = getHandle();
  // BullMQ verbietet ':' in Custom-Job-IDs — daher '-'. Mehrfach-Klicks während
  // ein Lauf aussteht sind No-Ops (ID existiert); alte Jobs vorher räumen.
  const jobId = `tax-deadline-manual-${tenantId}`;
  await queue.remove(jobId).catch(() => {});
  await queue.add('tax-deadline-materialize', { tenantId }, {
    jobId,
    removeOnComplete: 20,
    removeOnFail: 20,
  });
}
