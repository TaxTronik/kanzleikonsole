// =============================================================================
// n8n-Delivery-Worker
//
// Eine BullMQ-Ausführung stellt genau eine n8n_delivery zu. Dadurch retryen
// mehrere abonnierende Workflows unabhängig voneinander. Bereits liegende
// Altjobs mit `{ outboxId }` werden beim ersten Lauf in eine Legacy-Delivery
// materialisiert und bleiben rolling-deploy-kompatibel.
//
// S-01: Bleibt beim Owner-Client: Der Job kennt nur die Delivery-ID, und
// Zustellungen tenantloser Ereignisse (tenant_id NULL) sind unter der
// Tenant-RLS nicht erreichbar; Zustellung, Retry und Reconcile laufen daher
// über den Owner-Client.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { createWorker } from '../worker-factory';
import { n8nDeliveryMode } from '@taxtronik/config';
import { JOB_QUEUES } from '@taxtronik/config/job-queues';
import { readEncryptedSetting, SECRET_SLOTS, secretSlotContext } from '@taxtronik/crypto';
import { safeFetch, SsrfGuardError } from '@taxtronik/http-utils';
import { isAllowedN8nEvent, signOutboundN8n } from '@taxtronik/n8n-shared';
import {
  aggregateN8nOutboxTx,
  checkPlannedN8nRoute,
  legacyN8nTargetUrl,
  n8nDeliveryJob,
  n8nLegacyOutboxJob,
  n8nRoutingState,
  readN8nDeliveryConfig,
  resolveN8nSigningSecret,
  type N8nRoutingState,
  type N8nSecretFieldReader,
} from '@taxtronik/n8n-shared/outbox-enqueue';
import { connection, queues, type N8nDeliverJob } from '../queues';
import { log } from '../logger';
import { prismaOwner } from '../prisma-owner';

// Deutlich länger als der 15-s-HTTP-Timeout. Ein zweiter Worker darf eine
// Delivery erst nach diesem Lease übernehmen; Terminal-Updates sind zusätzlich
// an das zufällige Token gebunden.
const DELIVERY_LEASE_MS = 2 * 60_000;

/** Only a short diagnostic is persisted; never buffer a complete webhook error body. */
async function readErrorPrefix(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const prefix = new Uint8Array(1024);
  let size = 0;
  try {
    while (size < prefix.length) {
      const { value, done } = await reader.read();
      if (done) break;
      const count = Math.min(value.length, prefix.length - size);
      prefix.set(value.subarray(0, count), size);
      size += count;
    }
    return new TextDecoder().decode(prefix.subarray(0, size)).slice(0, 200);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * S-08: Entschlüsselung ausschließlich im Kontext von Tenant und Ablageort
 * (`SECRET_SLOTS[slot]`, unverändert). Ein nicht entschlüsselbarer Wert ergibt
 * '' — kein Rückfall auf Klartext-Altwerte oder ENV (Vorrangregel in
 * @taxtronik/n8n-shared, gleich wie in der Web-App).
 */
const readN8nSecretField: N8nSecretFieldReader = ({
  slot,
  fieldName,
  tenantId,
  encrypted,
  legacyPlain,
}) =>
  readEncryptedSetting(
    encrypted,
    legacyPlain,
    fieldName,
    secretSlotContext(SECRET_SLOTS[slot], { tenantId }),
    (field, err) =>
      log.warn(
        { field, err: err.message },
        'n8n-deliver: Signatur-Secret nicht entschlüsselbar (Key-Rotation ohne Re-Wrap?)',
      ),
  );

interface SigningState extends N8nRoutingState {
  secret: string;
}

async function resolveSigningState(tenantId: string | null): Promise<SigningState> {
  // Normalisierte Connection = alleinige Secret-/URL-Quelle; ein vorhandener
  // Legacy-Eintrag gilt als Ganzes; ENV nur ohne beides (R-01: eine Regel für
  // Outbox-Planung, Admin-Actions, Einstellungen und Worker).
  const config = await readN8nDeliveryConfig(prismaOwner, tenantId);
  const secret = resolveN8nSigningSecret(config.secretSource, readN8nSecretField);
  return { ...n8nRoutingState(config, Boolean(secret)), secret };
}

async function claimDelivery(deliveryId: string, leaseToken: string): Promise<boolean> {
  const now = new Date();
  const claimed = await prismaOwner.n8nDelivery.updateMany({
    where: {
      id: deliveryId,
      OR: [
        { status: 'PENDING' },
        {
          status: 'PROCESSING',
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
        },
      ],
    },
    data: {
      status: 'PROCESSING',
      leaseToken,
      leaseExpiresAt: new Date(now.getTime() + DELIVERY_LEASE_MS),
    },
  });
  return claimed.count === 1;
}

async function releaseDeliveryForRetry(
  deliveryId: string,
  leaseToken: string,
  error: string,
): Promise<void> {
  await prismaOwner.n8nDelivery.updateMany({
    where: { id: deliveryId, status: 'PROCESSING', leaseToken },
    data: {
      status: 'PENDING',
      leaseToken: null,
      leaseExpiresAt: null,
      lastError: error.slice(0, 1_000),
    },
  });
}

async function failClaimedDelivery(
  deliveryId: string,
  leaseToken: string,
  error: string,
): Promise<boolean> {
  return prismaOwner.$transaction(async (tx) => {
    const delivery = await tx.n8nDelivery.findFirst({
      where: { id: deliveryId, status: 'PROCESSING', leaseToken },
      select: { outboxId: true },
    });
    if (!delivery) return false;
    const updated = await tx.n8nDelivery.updateMany({
      where: { id: deliveryId, status: 'PROCESSING', leaseToken },
      data: {
        status: 'FAILED',
        leaseToken: null,
        leaseExpiresAt: null,
        lastError: error.slice(0, 1_000),
        deliveredAt: null,
      },
    });
    if (updated.count === 0) return false;
    await aggregateN8nOutboxTx(tx, delivery.outboxId);
    return true;
  });
}

async function markDeliveryTerminal(
  deliveryId: string,
  outboxId: string,
  leaseToken: string,
  status: 'DELIVERED' | 'FAILED' | 'SKIPPED',
  data: { httpStatus?: number | null; latencyMs?: number | null; lastError?: string | null } = {},
): Promise<boolean> {
  return prismaOwner.$transaction(async (tx) => {
    const updated = await tx.n8nDelivery.updateMany({
      where: { id: deliveryId, status: 'PROCESSING', leaseToken },
      data: {
        status,
        leaseToken: null,
        leaseExpiresAt: null,
        ...(data.httpStatus !== undefined ? { httpStatus: data.httpStatus } : {}),
        ...(data.latencyMs !== undefined ? { latencyMs: data.latencyMs } : {}),
        ...(data.lastError !== undefined ? { lastError: data.lastError } : {}),
        deliveredAt: status === 'DELIVERED' ? new Date() : null,
      },
    });
    if (updated.count === 0) return false;
    await aggregateN8nOutboxTx(tx, outboxId);
    return true;
  });
}

/** Materialisiert einen alten outboxId-Job genau einmal als Legacy-Delivery. */
async function ensureLegacyDelivery(outboxId: string): Promise<string | null> {
  return prismaOwner.$transaction(async (tx) => {
    // Rolling Deploys oder alte Queue-Daten können mehr als einen Legacy-Job
    // für dieselbe Outbox enthalten. Der Parent-Lock serialisiert sie vor der
    // Materialisierung; der nullable endpointId-Unique-Key allein verhindert
    // unter PostgreSQL keine zwei NULL-Zeilen.
    await tx.$queryRaw`SELECT "id" FROM "n8n_outbox" WHERE "id" = ${outboxId}::uuid FOR UPDATE`;
    const existing = await tx.n8nDelivery.findFirst({
      where: { outboxId },
      select: { id: true, endpointId: true, status: true },
    });
    if (existing) {
      // Ein Altjob darf nur eine bereits von ihm materialisierte, noch offene
      // Legacy-Delivery fortsetzen. Existieren neue explizite oder terminale
      // Deliveries, gehört die Zustellung deren eigenen Jobs.
      return existing.endpointId === null && existing.status === 'PENDING' ? existing.id : null;
    }

    const outbox = await tx.n8nOutbox.findUnique({
      where: { id: outboxId },
      select: { id: true, tenantId: true, event: true, status: true },
    });
    if (!outbox || outbox.status === 'DELIVERED' || outbox.status === 'SKIPPED') return null;

    const state = await resolveSigningState(outbox.tenantId);
    if (state.disabled || !state.legacyWebhookBaseUrl || !state.secret) {
      const reason = state.disabled
        ? 'n8n-Integration bewusst deaktiviert'
        : 'n8n nicht vollständig konfiguriert';
      await tx.n8nDelivery.create({
        data: {
          tenantId: outbox.tenantId,
          outboxId,
          connectionIdSnapshot: state.connectionId,
          endpointNameSnapshot: 'Legacy',
          targetUrl: null,
          status: 'SKIPPED',
          lastError: reason,
        },
      });
      await tx.n8nOutbox.update({
        where: { id: outboxId },
        data: { status: 'SKIPPED', lastError: reason, deliveredAt: null },
      });
      return null;
    }

    const delivery = await tx.n8nDelivery.create({
      data: {
        tenantId: outbox.tenantId,
        outboxId,
        connectionIdSnapshot: state.connectionId,
        endpointNameSnapshot: `Legacy: ${outbox.event}`,
        targetUrl: legacyN8nTargetUrl(state.legacyWebhookBaseUrl, outbox.event),
      },
      select: { id: true },
    });
    return delivery.id;
  });
}

async function sendSignedDelivery(input: {
  deliveryId: string;
  outboxId: string;
  event: string;
  targetUrl: string;
  testMode: boolean;
  leaseToken: string;
  signature: string;
  timestamp: string;
  nonce: string;
  body: string;
}): Promise<void> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 15_000);
  const startedAt = Date.now();
  try {
    let response: Response;
    try {
      response = await safeFetch(
        input.targetUrl,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-taxtronik-signature': input.signature,
            'x-taxtronik-timestamp': input.timestamp,
            'x-taxtronik-event': input.event,
            'x-taxtronik-nonce': input.nonce,
            'x-taxtronik-delivery-id': input.deliveryId,
          },
          body: input.body,
          signal: ctrl.signal,
          redirect: 'error',
        },
        { mode: 'n8n', kind: input.testMode ? 'webhook-test' : 'webhook' },
      );
    } catch (err) {
      if (err instanceof SsrfGuardError) {
        await markDeliveryTerminal(input.deliveryId, input.outboxId, input.leaseToken, 'FAILED', {
          latencyMs: Date.now() - startedAt,
          lastError: `SSRF-Guard (${err.reason}): ${err.message}`,
        });
        return;
      }
      throw err;
    }

    const latencyMs = Date.now() - startedAt;
    if (response.ok) {
      // safeFetch pinnt den Dispatcher bis der Body konsumiert oder verworfen
      // wurde. Erfolgsantworten brauchen keinen Inhalt, müssen ihren Stream
      // aber vor clearTimeout() freigeben, sonst leakt pro Delivery ein Agent.
      if (response.body) {
        try {
          await response.body.cancel();
        } catch (err) {
          log.warn(
            { deliveryId: input.deliveryId, err: (err as Error).message },
            'n8n-deliver: response body could not be cancelled',
          );
        }
      }
      await markDeliveryTerminal(input.deliveryId, input.outboxId, input.leaseToken, 'DELIVERED', {
        httpStatus: response.status,
        latencyMs,
        lastError: null,
      });
      log.debug({ deliveryId: input.deliveryId, outboxId: input.outboxId }, 'n8n-deliver: ok');
      return;
    }

    const responseText = await readErrorPrefix(response).catch(() => '');
    const error = `HTTP ${response.status}: ${responseText}`;
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      await markDeliveryTerminal(input.deliveryId, input.outboxId, input.leaseToken, 'FAILED', {
        httpStatus: response.status,
        latencyMs,
        lastError: error,
      });
      return;
    }

    await prismaOwner.n8nDelivery.updateMany({
      where: { id: input.deliveryId, status: 'PROCESSING', leaseToken: input.leaseToken },
      data: { httpStatus: response.status, latencyMs, lastError: error },
    });
    throw new Error(error);
  } finally {
    ctrl.abort();
    clearTimeout(timeout);
  }
}

async function readDelivery(deliveryId: string) {
  return prismaOwner.n8nDelivery.findUnique({
    where: { id: deliveryId },
    include: {
      outbox: true,
      endpoint: {
        select: {
          enabled: true,
          connectionId: true,
          productionUrl: true,
          testUrl: true,
          testMode: true,
          subscriptions: {
            where: { enabled: true },
            select: { event: true },
          },
        },
      },
    },
  });
}

async function deliver(deliveryId: string, leaseToken: string): Promise<void> {
  const delivery = await readDelivery(deliveryId);
  if (!delivery) {
    log.warn({ deliveryId }, 'n8n-deliver: delivery not found, skipping');
    return;
  }
  if (delivery.status !== 'PROCESSING' || delivery.leaseToken !== leaseToken) {
    log.debug({ deliveryId, status: delivery.status }, 'n8n-deliver: terminal delivery, skipping');
    return;
  }

  const outbox = delivery.outbox;
  if (!isAllowedN8nEvent(outbox.event)) {
    await markDeliveryTerminal(delivery.id, outbox.id, leaseToken, 'FAILED', {
      lastError: `Event '${outbox.event}' nicht in Whitelist.`,
    });
    return;
  }
  if (delivery.endpoint && !delivery.endpoint.enabled) {
    await markDeliveryTerminal(delivery.id, outbox.id, leaseToken, 'SKIPPED', {
      lastError: 'n8n-Endpoint wurde deaktiviert',
    });
    return;
  }

  const state = await resolveSigningState(outbox.tenantId);
  // Dieselbe Snapshot-Prüfung wie die Retry-Action (R-01): Zielauswahl über
  // plannedN8nTarget, also auch für Routen im testMode.
  const target = checkPlannedN8nRoute(
    {
      targetUrl: delivery.targetUrl,
      connectionIdSnapshot: delivery.connectionIdSnapshot,
      event: outbox.event,
      endpoint: delivery.endpoint,
    },
    state,
  );
  if (!target.ok) {
    await markDeliveryTerminal(delivery.id, outbox.id, leaseToken, 'SKIPPED', {
      lastError: target.reason,
    });
    return;
  }

  const attemptAt = new Date();
  const attempt = await prismaOwner.n8nDelivery.updateMany({
    where: { id: delivery.id, status: 'PROCESSING', leaseToken },
    data: {
      attempts: { increment: 1 },
      firstAttemptAt: delivery.firstAttemptAt ?? attemptAt,
      lastAttemptAt: attemptAt,
    },
  });
  if (attempt.count === 0) return;
  await prismaOwner.n8nOutbox.update({
    where: { id: outbox.id },
    data: { attempts: { increment: 1 } },
  });

  const body = JSON.stringify({
    schemaVersion: 1,
    eventId: outbox.id,
    deliveryId: delivery.id,
    event: outbox.event,
    tenantId: outbox.tenantId,
    occurredAt: outbox.occurredAt.toISOString(),
    payload: outbox.payload,
  });
  const { signature, timestamp, nonce } = signOutboundN8n(outbox.event, body, state.secret);

  if (n8nDeliveryMode === 'log') {
    log.info(
      {
        deliveryId: delivery.id,
        outboxId: outbox.id,
        event: outbox.event,
        targetUrl: delivery.targetUrl,
      },
      'n8n-deliver: DRY-RUN (N8N_DELIVERY_MODE=log)',
    );
    await markDeliveryTerminal(delivery.id, outbox.id, leaseToken, 'SKIPPED', {
      lastError: 'log-only (N8N_DELIVERY_MODE=log)',
    });
    return;
  }

  await sendSignedDelivery({
    deliveryId: delivery.id,
    outboxId: outbox.id,
    event: outbox.event,
    targetUrl: target.targetUrl,
    testMode: target.useTestUrl,
    leaseToken,
    signature,
    timestamp,
    nonce,
    body,
  });
}

function deliveryIdFrom(data: N8nDeliverJob): string | null {
  return 'deliveryId' in data && data.deliveryId ? data.deliveryId : null;
}

export const n8nDeliverWorker = createWorker<N8nDeliverJob>(
  JOB_QUEUES.n8nDeliver.name,
  async (job) => {
    const deliveryId =
      deliveryIdFrom(job.data) ??
      (job.data.outboxId ? await ensureLegacyDelivery(job.data.outboxId) : null);
    if (!deliveryId) return;
    const leaseToken = randomUUID();
    if (!(await claimDelivery(deliveryId, leaseToken))) {
      log.debug({ deliveryId }, 'n8n-deliver: delivery already claimed or terminal');
      return;
    }
    try {
      await deliver(deliveryId, leaseToken);
    } catch (err) {
      const message = (err as Error).message;
      const lastAttempt = (job.attemptsMade ?? 0) + 1 >= (job.opts?.attempts ?? 1);
      if (lastAttempt) {
        await failClaimedDelivery(deliveryId, leaseToken, message);
      } else {
        await releaseDeliveryForRetry(deliveryId, leaseToken, message);
      }
      throw err;
    }
  },
  { connection, concurrency: 4 },
);

// Findet Deliveries, die zwischen DB-Commit und BullMQ-Add liegen geblieben
// sind oder deren Worker nach dem DB-Claim abgestürzt ist.
export const n8nOutboxReconcileWorker = createWorker(
  JOB_QUEUES.n8nOutboxReconcile.name,
  async () => {
    const cutoff = new Date(Date.now() - 5 * 60_000);
    const now = new Date();
    const [stuckDeliveries, legacyOutboxes] = await Promise.all([
      prismaOwner.n8nDelivery.findMany({
        where: {
          OR: [
            { status: 'PENDING', createdAt: { lt: cutoff } },
            {
              status: 'PROCESSING',
              OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
            },
          ],
        },
        select: { id: true, status: true },
        take: 500,
      }),
      // Rolling-Deploy-Kompatibilität: Vor dieser Migration persistierte
      // Outbox-Events besitzen noch keine Delivery. Falls ihr alter BullMQ-Job
      // verloren ging, materialisiert der deterministische Legacy-Job sie.
      prismaOwner.n8nOutbox.findMany({
        where: {
          status: 'PENDING',
          createdAt: { lt: cutoff },
          deliveries: { none: {} },
        },
        select: { id: true },
        take: 500,
      }),
    ]);
    if (stuckDeliveries.length === 0 && legacyOutboxes.length === 0) return;

    // R-01: die langlebige Producer-Queue des Workers statt einer je Lauf neu
    // erzeugten und wieder geschlossenen Queue-Instanz.
    const queue = queues.n8nDeliver;
    for (const row of stuckDeliveries) {
      // PENDING behält den deduplizierenden Key (und damit seinen BullMQ-
      // Backoff); ein abgelaufener PROCESSING-Lease erhält einen Fenster-Key.
      const job = n8nDeliveryJob(
        row.id,
        row.status === 'PROCESSING' ? { kind: 'recovery', now } : { kind: 'initial' },
      );
      await queue.add(job.name, job.data, job.opts);
    }
    for (const row of legacyOutboxes) {
      const job = n8nLegacyOutboxJob(row.id);
      await queue.add(job.name, job.data, job.opts);
    }
    log.info(
      {
        deliveriesRequeued: stuckDeliveries.length,
        legacyOutboxesRequeued: legacyOutboxes.length,
      },
      'n8n-delivery: reconciliation',
    );
  },
  { connection },
);
