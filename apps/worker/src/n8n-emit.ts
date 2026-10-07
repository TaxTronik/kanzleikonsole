// =============================================================================
// n8n-Event-Emission aus dem Worker.
//
// Adapter um den geteilten Enqueue-Kern (@taxtronik/n8n-shared/outbox-enqueue)
// — Pendant zu apps/web/src/server/n8n/outbox.ts. Der Worker BESITZT die
// n8n-deliver-Queue, deshalb ohne die withTimeout-Deckelung der Web-Server-
// Actions: Jobs laufen hier nicht in einem interaktiven Request.
//
// S-01: Der Enqueue-Kern schreibt auch tenantlose Ereignisse und prüft global
// eindeutige Dedupe-Schlüssel; beides geht unter der Tenant-RLS nicht, daher
// Owner-Client.
// =============================================================================

import type { N8nEventName } from '@taxtronik/n8n-shared';
import {
  enqueueN8nEventCore,
  n8nDeliveryJob,
  type N8nEnqueueResult,
} from '@taxtronik/n8n-shared/outbox-enqueue';
import { prismaOwner } from './prisma-owner';
import { queues } from './queues';
import { log } from './logger';

export async function emitN8nEventFromWorker(
  event: N8nEventName,
  payload: Record<string, unknown>,
  opts: { tenantId?: string; dedupeKey?: string } = {},
): Promise<N8nEnqueueResult> {
  return enqueueN8nEventCore(
    {
      db: prismaOwner,
      log,
      enqueueDelivery: (deliveryId) => {
        const job = n8nDeliveryJob(deliveryId);
        return queues.n8nDeliver.add(job.name, job.data, job.opts);
      },
    },
    event,
    payload,
    opts,
  );
}
