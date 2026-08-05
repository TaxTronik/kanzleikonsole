// =============================================================================
// n8n-Event-Emission aus dem Worker.
//
// Adapter um den geteilten Enqueue-Kern (@taxtronik/n8n-shared/outbox-enqueue)
// — Pendant zu apps/web/src/server/n8n/outbox.ts. Der Worker BESITZT die
// n8n-deliver-Queue, deshalb ohne die withTimeout-Deckelung der Web-Server-
// Actions: Jobs laufen hier nicht in einem interaktiven Request.
// =============================================================================

import type { N8nEventName } from '@taxtronik/n8n-shared';
import {
  enqueueN8nEventCore,
  DELIVERY_JOB_OPTIONS,
  type N8nEnqueueResult,
} from '@taxtronik/n8n-shared/outbox-enqueue';
import { prismaOwner } from './prisma-owner';
import { n8nDeliverQueue } from './queues';
import { log } from './logger';

export async function emitN8nEventFromWorker(
  event: N8nEventName,
  payload: Record<string, unknown>,
  opts: { tenantId?: string } = {},
): Promise<N8nEnqueueResult> {
  return enqueueN8nEventCore(
    {
      db: prismaOwner,
      log,
      enqueueDelivery: (deliveryId) =>
        n8nDeliverQueue.add(
          'deliver',
          { deliveryId },
          { ...DELIVERY_JOB_OPTIONS, jobId: `delivery-${deliveryId}` },
        ),
    },
    event,
    payload,
    opts,
  );
}
