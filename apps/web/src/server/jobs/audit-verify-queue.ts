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
import { randomUUID } from 'node:crypto';
import { env } from '@taxtronik/config';
import { log } from '@/server/logger';

interface AuditVerifyJob {
  tenantId: string;
  requestedByStaffId?: string;
  requestId?: string;
}

declare global {
  // `var` is intentional for ambient globalThis augmentation.
  // noinspection ES6ConvertVarToLetConst
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
  // IMMER cachen — nicht nur im Dev: sonst leakt in Produktion jeder Aufruf
  // eine neue IORedis-Connection (bis Redis maxclients erschöpft ist).
  globalThis.__taxtronik_audit_verify_queue = handle;
  return handle;
}

/** Reiht eine manuelle Chain-Verifikation für EINEN Tenant ein und liefert die Lauf-ID. */
export async function enqueueAuditVerify(
  tenantId: string,
  requestedByStaffId?: string,
): Promise<string> {
  const { queue } = getHandle();
  // Die UI wartet exakt auf diese requestId. Eine feste jobId pro Tenant kann
  // ein altes Persistenz-Ergebnis wie einen frischen Lauf aussehen lassen.
  const requestId = randomUUID();
  const jobId = `audit-verify-manual-${tenantId}-${requestId}`;
  await queue.add(
    'audit-verify-check',
    { tenantId, requestedByStaffId, requestId },
    {
      jobId,
      removeOnComplete: 20,
      removeOnFail: 20,
    },
  );
  return requestId;
}
