// =============================================================================
// BullMQ-Queue für manuell ausgelöste audit-verify-check-Jobs („Jetzt prüfen"
// auf /staff/admin/audit).
//
// Singleton-Pattern analog zu audit-rotate-queue.ts: BullMQ erfordert eine
// eigene Connection mit `maxRetriesPerRequest: null`; statt pro Klick eine
// neue Verbindung auf-/abzubauen, halten wir eine modulweite Connection.
// =============================================================================

import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { env } from '@taxtronik/config';
import { log } from '@/server/logger';

interface AuditVerifyJob {
  tenantId: string;
}

declare global {
  var __taxtronik_audit_verify_queue: { conn: IORedis; queue: Queue<AuditVerifyJob> } | undefined;
}

function init(): { conn: IORedis; queue: Queue<AuditVerifyJob> } {
  const conn = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  conn.on('error', (err) => {
    log.warn({ component: 'audit-verify-queue', err: err.message }, 'redis error');
  });
  const queue = new Queue<AuditVerifyJob>('audit-verify-check', { connection: conn });
  return { conn, queue };
}

function getHandle(): { conn: IORedis; queue: Queue<AuditVerifyJob> } {
  const existing = globalThis.__taxtronik_audit_verify_queue;
  if (existing) return existing;

  const handle = init();
  if (env.NODE_ENV !== 'production') {
    globalThis.__taxtronik_audit_verify_queue = handle;
  }
  return handle;
}

/** Reiht eine manuelle Chain-Verifikation für EINEN Tenant ein. Idempotent über jobId. */
export async function enqueueAuditVerify(tenantId: string): Promise<void> {
  const { queue } = getHandle();
  // BullMQ verbietet ':' in Custom-Job-IDs — daher '-'. Mehrfach-Klicks während
  // ein Lauf aussteht sind No-Ops (ID existiert); abgeschlossene/gescheiterte
  // Jobs werden vorher geräumt, damit ein erneuter Anstoß durchläuft.
  const jobId = `audit-verify-manual-${tenantId}`;
  await queue.remove(jobId).catch(() => {});
  await queue.add('audit-verify-check', { tenantId }, {
    jobId,
    removeOnComplete: 20,
    removeOnFail: 20,
  });
}
