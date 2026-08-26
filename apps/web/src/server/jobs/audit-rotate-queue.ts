// =============================================================================
// BullMQ-Queue für manuell ausgelöste audit-rotate-Jobs.
//
// Die Queue kommt aus dem zentralen Web-BullMQ-Registry und teilt sich dessen
// langlebige Connection mit allen anderen Produzenten.
// =============================================================================

import { JOB_QUEUES } from '@taxtronik/config/job-queues';

import { getWebQueue } from './bullmq';

export function getAuditRotateQueue() {
  return getWebQueue(JOB_QUEUES.auditRotate.name);
}
