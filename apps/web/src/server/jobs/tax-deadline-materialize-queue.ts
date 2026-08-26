// =============================================================================
// BullMQ-Queue für manuell ausgelöste tax-deadline-materialize-Jobs
// („Neu berechnen" auf /staff/tax-deadlines).
//
// Die tenant-weite Materialisierung gehört nicht in eine interaktive 15-s-Server-Action-Tx
// (P2028 bei vielen Mandanten) — der Worker-Job tax-deadline-materialize
// übernimmt sie im Hintergrund. Die Queue kommt aus dem zentralen Registry.
// =============================================================================

import { JOB_QUEUES } from '@taxtronik/config/job-queues';

import { withTimeout } from '@/lib/with-timeout';
import { getWebQueue, WEB_QUEUE_TIMEOUT_MS } from './bullmq';

/** Reiht die Materialisierung für EINEN Tenant ein. Idempotent über jobId. */
export async function enqueueTaxDeadlineMaterialize(tenantId: string): Promise<void> {
  const queue = getWebQueue(JOB_QUEUES.taxDeadlineMaterialize.name);
  // BullMQ verbietet ':' in Custom-Job-IDs — daher '-'. Mehrfach-Klicks während
  // ein Lauf aussteht sind No-Ops (ID existiert); alte Jobs vorher räumen.
  const jobId = `tax-deadline-manual-${tenantId}`;
  await withTimeout(queue.remove(jobId), WEB_QUEUE_TIMEOUT_MS).catch(() => {});
  await withTimeout(
    queue.add(
      JOB_QUEUES.taxDeadlineMaterialize.name,
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
    WEB_QUEUE_TIMEOUT_MS,
  );
}
