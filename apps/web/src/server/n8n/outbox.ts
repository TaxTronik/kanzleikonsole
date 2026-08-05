// =============================================================================
// n8n-Outbox — Web-Adapter um den geteilten Enqueue-Kern.
//
// Die Zielauflösung (Connection/Subscription/Legacy-Routing) lebt jetzt in
// @taxtronik/n8n-shared/outbox-enqueue, damit auch der Worker Events
// emittieren kann (Auto-Anforderungen aus Steuerterminen). Hier bleibt nur
// die Web-Infrastruktur: prismaOwner-Singleton, Web-Logger und der
// withTimeout-gedeckelte BullMQ-Add.
// =============================================================================

import type { N8nEventName } from '@taxtronik/n8n-shared';
import {
  enqueueN8nEventCore,
  DELIVERY_JOB_OPTIONS,
  type N8nEnqueueResult,
  type N8nEnqueueStatus,
} from '@taxtronik/n8n-shared/outbox-enqueue';
import { prismaOwner } from '@/server/db/prisma-owner';
import { log } from '@/server/logger';
import { withTimeout } from '@/lib/with-timeout';
import { getN8nDeliverQueue } from './queue';

export type { N8nEnqueueResult, N8nEnqueueStatus };

export async function enqueueN8nEvent(
  event: N8nEventName,
  payload: Record<string, unknown>,
  opts: { tenantId?: string } = {},
): Promise<N8nEnqueueResult> {
  return enqueueN8nEventCore(
    {
      db: prismaOwner,
      log,
      // Timeout-gedeckelt: bei Redis-Ausfall/Reconnect parkt ioredis den
      // Befehl in der Offline-Queue und das add()-Promise resolved/rejected
      // NIE — Server Actions (z. B. GwG-Verifikation) hingen dadurch
      // minutenlang nach bereits committeter Transaktion. Der Reconcile-Job
      // sammelt stuck PENDING-Deliveries ohnehin alle 5 Minuten ein.
      enqueueDelivery: (deliveryId) =>
        withTimeout(
          getN8nDeliverQueue().add(
            'deliver',
            { deliveryId },
            { ...DELIVERY_JOB_OPTIONS, jobId: `delivery-${deliveryId}` },
          ),
          2_000,
        ),
    },
    event,
    payload,
    opts,
  );
}
