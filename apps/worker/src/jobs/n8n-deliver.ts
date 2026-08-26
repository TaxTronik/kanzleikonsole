// =============================================================================
// n8n-Delivery-Worker
//
// Eine BullMQ-Ausführung stellt genau eine n8n_delivery zu. Dadurch retryen
// mehrere abonnierende Workflows unabhängig voneinander. Bereits liegende
// Altjobs mit `{ outboxId }` werden beim ersten Lauf in eine Legacy-Delivery
// materialisiert und bleiben rolling-deploy-kompatibel.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import type { Prisma } from '@prisma/client';
import { env, n8nDeliveryMode } from '@taxtronik/config';
import { JOB_QUEUES } from '@taxtronik/config/job-queues';
import { decryptSecret, looksEncrypted } from '@taxtronik/crypto';
import { readTenantSettingValue } from '@taxtronik/db/tenant-settings';
import { safeFetch, SsrfGuardError } from '@taxtronik/http-utils';
import { isAllowedN8nEvent, signOutboundN8n } from '@taxtronik/n8n-shared';
import { connection, type N8nDeliverJob } from '../queues';
import { log } from '../logger';
import { prismaOwner } from '../prisma-owner';

const DELIVERY_JOB_OPTIONS = {
  attempts: 6,
  backoff: { type: 'exponential' as const, delay: 60_000 },
  removeOnComplete: { age: 24 * 60 * 60 },
  removeOnFail: { age: 7 * 24 * 60 * 60 },
};

// Deutlich länger als der 15-s-HTTP-Timeout. Ein zweiter Worker darf eine
// Delivery erst nach diesem Lease übernehmen; Terminal-Updates sind zusätzlich
// an das zufällige Token gebunden.
const DELIVERY_LEASE_MS = 2 * 60_000;
// Reconcile läuft alle fünf Minuten. Nur eine Delivery mit abgelaufenem
// PROCESSING-Lease erhält einen zeitgebundenen Job-Key: Er umgeht den completed
// Tombstone des ursprünglichen Jobs, dedupliziert aber parallele Reconcile-
// Läufe desselben Fensters. PENDING-Jobs behalten ihren BullMQ-Backoff.
const RECONCILE_JOB_BUCKET_MS = 5 * 60_000;

function deliveryRecoveryJobId(id: string, now: Date): string {
  return `recovery-delivery-${id}-${Math.floor(now.getTime() / RECONCILE_JOB_BUCKET_MS)}`;
}

interface LegacyStored {
  webhookBaseUrl?: string;
  hmacEncrypted?: string;
  hmacSecret?: string;
}

function decryptIfUsable(value: string | null | undefined): string {
  if (!value) return '';
  if (!looksEncrypted(value)) return '';
  try {
    return decryptSecret(value);
  } catch {
    return '';
  }
}

async function readLegacyStored(tenantId: string | null): Promise<LegacyStored | null> {
  if (!tenantId) return null;
  const stored = await readTenantSettingValue(prismaOwner, tenantId, 'integrations.n8n');
  return stored === undefined ? null : (stored as LegacyStored);
}

async function resolveSigningState(tenantId: string | null): Promise<{
  secret: string;
  disabled: boolean;
  connectionId: string | null;
  legacyBaseUrl: string;
  routingMode: 'DISABLED' | 'LEGACY' | 'EXPLICIT' | null;
}> {
  const connectionRow = tenantId
    ? await prismaOwner.n8nConnection.findUnique({
        where: { tenantId },
        select: {
          id: true,
          enabled: true,
          routingMode: true,
          webhookBaseUrl: true,
          signingSecretEncrypted: true,
        },
      })
    : null;
  // Normalisierte Connection = alleinige Secret-/URL-Quelle. Legacy und ENV
  // gelten nur für Tenants, die noch gar keine Connection-Reihe besitzen.
  const stored = connectionRow ? null : await readLegacyStored(tenantId);
  const connectionSecret = decryptIfUsable(connectionRow?.signingSecretEncrypted);
  const legacySecret = decryptIfUsable(stored?.hmacEncrypted) || stored?.hmacSecret || '';
  return {
    secret: connectionRow ? connectionSecret : legacySecret || env.N8N_HMAC_SECRET || '',
    connectionId: connectionRow?.id ?? null,
    routingMode: connectionRow?.routingMode ?? null,
    disabled: Boolean(
      connectionRow && (!connectionRow.enabled || connectionRow.routingMode === 'DISABLED'),
    ),
    legacyBaseUrl: connectionRow
      ? connectionRow.webhookBaseUrl?.trim() || ''
      : stored?.webhookBaseUrl?.trim() || env.N8N_WEBHOOK_BASE_URL || '',
  };
}

function legacyTargetUrl(baseUrl: string, event: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const targetBase =
    n8nDeliveryMode === 'test' ? base.replace(/\/webhook$/, '/webhook-test') : base;
  return `${targetBase}/${encodeURIComponent(event)}`;
}

async function lockAndAggregateOutbox(
  tx: Prisma.TransactionClient,
  outboxId: string,
): Promise<void> {
  // Serialisiert konkurrierende Terminal-Updates verschiedener Fan-out-
  // Deliveries. Ohne Parent-Lock kann ein älterer PENDING-Snapshot nach einem
  // neueren DELIVERED-Update gewinnen.
  await tx.$queryRaw`SELECT "id" FROM "n8n_outbox" WHERE "id" = ${outboxId}::uuid FOR UPDATE`;
  const deliveries = await tx.n8nDelivery.findMany({
    where: { outboxId },
    select: { status: true, lastError: true, deliveredAt: true },
  });
  if (deliveries.length === 0) return;

  const pending = deliveries.some(
    (delivery) => delivery.status === 'PENDING' || delivery.status === 'PROCESSING',
  );
  const allDelivered = deliveries.every((d) => d.status === 'DELIVERED');
  const allFailed = deliveries.every((d) => d.status === 'FAILED');
  const allSkipped = deliveries.every((d) => d.status === 'SKIPPED');
  const status = pending
    ? 'PENDING'
    : allDelivered
      ? 'DELIVERED'
      : allFailed
        ? 'FAILED'
        : allSkipped
          ? 'SKIPPED'
          : 'PARTIAL';
  const deliveredAt = allDelivered
    ? deliveries.reduce<Date | null>(
        (latest, d) =>
          d.deliveredAt && (!latest || d.deliveredAt > latest) ? d.deliveredAt : latest,
        null,
      )
    : null;
  const lastError =
    status === 'DELIVERED'
      ? null
      : (deliveries.find((d) => d.status === 'FAILED')?.lastError ??
        deliveries.find((d) => d.status === 'SKIPPED')?.lastError ??
        null);

  await tx.n8nOutbox.update({
    where: { id: outboxId },
    data: { status, deliveredAt, lastError },
  });
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
    await lockAndAggregateOutbox(tx, delivery.outboxId);
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
    await lockAndAggregateOutbox(tx, outboxId);
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
    if (state.disabled || !state.legacyBaseUrl || !state.secret) {
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
        targetUrl: legacyTargetUrl(state.legacyBaseUrl, outbox.event),
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

    const responseText = await response.text().catch(() => '');
    const error = `HTTP ${response.status}: ${responseText.slice(0, 200)}`;
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
    clearTimeout(timeout);
  }
}

async function deliver(deliveryId: string, leaseToken: string): Promise<void> {
  const delivery = await prismaOwner.n8nDelivery.findUnique({
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
  // Exakter Snapshot-Abgleich in beide Richtungen. Auch eine alte Legacy-
  // Delivery (null) darf nach dem Anlegen einer Connection nicht plötzlich
  // mit deren neuem Secret zugestellt werden.
  const plannedConnectionMissing = delivery.connectionIdSnapshot !== state.connectionId;
  // Spiegelt die Zielwahl aus der Outbox-Planung: global test ODER
  // Route-Debug-Schalter testMode → Test-URL, sonst Produktions-URL.
  const expectedExplicitTarget =
    n8nDeliveryMode === 'test' || delivery.endpoint?.testMode
      ? delivery.endpoint?.testUrl
      : delivery.endpoint?.productionUrl;
  const explicitRouteChanged = delivery.endpoint
    ? !delivery.endpoint.enabled ||
      delivery.endpoint.connectionId !== state.connectionId ||
      expectedExplicitTarget !== delivery.targetUrl ||
      !delivery.endpoint.subscriptions.some((subscription) => subscription.event === outbox.event)
    : state.routingMode === 'EXPLICIT';
  const legacyRouteChanged =
    !delivery.endpoint &&
    state.routingMode !== 'EXPLICIT' &&
    (!state.legacyBaseUrl ||
      delivery.targetUrl !== legacyTargetUrl(state.legacyBaseUrl, outbox.event));
  if (
    state.disabled ||
    plannedConnectionMissing ||
    explicitRouteChanged ||
    legacyRouteChanged ||
    !delivery.targetUrl ||
    !state.secret
  ) {
    await markDeliveryTerminal(delivery.id, outbox.id, leaseToken, 'SKIPPED', {
      lastError: state.disabled
        ? 'n8n-Integration bewusst deaktiviert'
        : plannedConnectionMissing
          ? 'n8n-Connection der geplanten Route wurde entfernt oder ersetzt'
          : explicitRouteChanged
            ? 'n8n-Route, Ziel-URL oder Event-Zuordnung wurde geändert'
            : legacyRouteChanged
              ? 'n8n-Legacy-Ziel wurde geändert'
              : !delivery.targetUrl
                ? 'n8n-Ziel-URL fehlt'
                : 'n8n-Signatur-Secret fehlt',
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
    targetUrl: delivery.targetUrl,
    testMode: n8nDeliveryMode === 'test' || delivery.endpoint?.testMode === true,
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

export const n8nDeliverWorker = new Worker<N8nDeliverJob>(
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

n8nDeliverWorker.on('failed', (job, err) => {
  if (!job) return;
  if (job.attemptsMade < (job.opts?.attempts ?? 1)) {
    log.warn({ attempt: job.attemptsMade, err: err.message }, 'n8n-deliver: retry pending');
  } else {
    log.error(
      { deliveryId: deliveryIdFrom(job.data), attempts: job.attemptsMade, err: err.message },
      'n8n-deliver: FAILED after all retries',
    );
  }
});

// Findet Deliveries, die zwischen DB-Commit und BullMQ-Add liegen geblieben
// sind oder deren Worker nach dem DB-Claim abgestürzt ist.
export const n8nOutboxReconcileWorker = new Worker(
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

    const queue = new Queue<N8nDeliverJob>(JOB_QUEUES.n8nDeliver.name, { connection });
    for (const row of stuckDeliveries) {
      await queue.add(
        'deliver',
        { deliveryId: row.id },
        {
          ...DELIVERY_JOB_OPTIONS,
          jobId:
            row.status === 'PROCESSING' ? deliveryRecoveryJobId(row.id, now) : `delivery-${row.id}`,
        },
      );
    }
    for (const row of legacyOutboxes) {
      await queue.add(
        'deliver',
        { outboxId: row.id },
        { ...DELIVERY_JOB_OPTIONS, jobId: `outbox-${row.id}` },
      );
    }
    await queue.close();
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
