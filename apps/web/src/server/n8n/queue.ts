// =============================================================================
// BullMQ-Queue für n8n-Auslieferung (S15 Outbox-Pattern)
//
// Wird von emit/outbox benutzt, um Outbox-Reihen an den Worker weiterzureichen.
// Queue und Connection kommen aus dem zentralen Web-BullMQ-Registry.
// =============================================================================

import { JOB_QUEUES } from '@taxtronik/config/job-queues';

import { getWebQueue } from '@/server/jobs/bullmq';

export type { N8nDeliverJob } from '@taxtronik/config/job-queues';

export function getN8nDeliverQueue() {
  return getWebQueue(JOB_QUEUES.n8nDeliver.name);
}
