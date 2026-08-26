// =============================================================================
// BullMQ-Queue für manuell ausgelöste audit-verify-check-Jobs („Jetzt prüfen"
// auf /staff/admin/audit).
//
// Die Queue kommt aus dem zentralen Web-BullMQ-Registry.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { JOB_QUEUES } from '@taxtronik/config/job-queues';

import { withTimeout } from '@/lib/with-timeout';
import { getWebQueue, WEB_QUEUE_TIMEOUT_MS } from './bullmq';

/** Reiht eine manuelle Chain-Verifikation für EINEN Tenant ein und liefert die Lauf-ID. */
export async function enqueueAuditVerify(
  tenantId: string,
  requestedByStaffId?: string,
): Promise<string> {
  const queue = getWebQueue(JOB_QUEUES.auditVerify.name);
  // Die UI wartet exakt auf diese requestId. Eine feste jobId pro Tenant kann
  // ein altes Persistenz-Ergebnis wie einen frischen Lauf aussehen lassen.
  const requestId = randomUUID();
  const jobId = `audit-verify-manual-${tenantId}-${requestId}`;
  await withTimeout(
    queue.add(
      JOB_QUEUES.auditVerify.name,
      { tenantId, requestedByStaffId, requestId },
      {
        jobId,
        removeOnComplete: 20,
        removeOnFail: 20,
      },
    ),
    WEB_QUEUE_TIMEOUT_MS,
  );
  return requestId;
}
