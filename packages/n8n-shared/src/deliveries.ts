// =============================================================================
// n8n-Deliveries — gemeinsame DB-Bausteine für Web und Worker (R-01)
//
// Konfiguration laden (Vorrangregel aus routing.ts), aktive Routen eines
// Events finden, Delivery-Reihen planen und den Outbox-Status aus seinen
// Deliveries aggregieren. Vormals je eine Kopie in outbox-enqueue.ts, im
// Worker und in den Admin-Actions (Replay) bzw. server/n8n/deliveries.ts.
// Alle Funktionen nehmen den Client bzw. die Transaktion des Aufrufers.
// =============================================================================

import type { Prisma } from '@prisma/client';
import type { N8nDeliveryMode } from '@taxtronik/config';
import {
  LEGACY_N8N_SETTING_KEY,
  n8nDeliveryConfigFrom,
  plannedN8nTarget,
  type N8nDeliveryConfig,
  type N8nRoutingConnection,
} from './routing';

/** Lesender Zugriff auf Connection und Legacy-Setting (Owner-Client oder Tenant-Tx). */
export type N8nDeliveryConfigReader = Pick<
  Prisma.TransactionClient,
  'n8nConnection' | 'tenantSetting'
>;

const ROUTING_CONNECTION_SELECT = {
  id: true,
  name: true,
  enabled: true,
  routingMode: true,
  webhookBaseUrl: true,
  signingSecretEncrypted: true,
} as const;

/**
 * Lädt die für das Routing wirksame Konfiguration eines Tenants. Der
 * Legacy-Eintrag wird nur gelesen, wenn noch keine normalisierte Connection
 * existiert; ohne Tenant gilt ausschließlich ENV.
 */
export async function readN8nDeliveryConfig(
  db: N8nDeliveryConfigReader,
  tenantId: string | null,
): Promise<N8nDeliveryConfig> {
  const connection: N8nRoutingConnection | null = tenantId
    ? await db.n8nConnection.findUnique({
        where: { tenantId },
        select: ROUTING_CONNECTION_SELECT,
      })
    : null;
  let legacySetting: unknown = undefined;
  if (tenantId && !connection) {
    const row = await db.tenantSetting.findUnique({
      where: { tenantId_key: { tenantId, key: LEGACY_N8N_SETTING_KEY } },
      select: { value: true },
    });
    legacySetting = row ? row.value : undefined;
  }
  return n8nDeliveryConfigFrom({ tenantId, connection, legacySetting });
}

/** Aktive explizite Route mit den Feldern, die ihr Ziel bestimmen. */
export interface N8nRouteEndpoint {
  id: string;
  name: string;
  productionUrl: string;
  testUrl: string | null;
  testMode: boolean;
}

/** Aktive Routen (Route + Abo aktiv) einer Connection für ein Event. */
export async function findActiveN8nRouteEndpointsTx(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; event: string; connectionId: string },
): Promise<N8nRouteEndpoint[]> {
  const subscriptions = await tx.n8nEventSubscription.findMany({
    where: {
      tenantId: input.tenantId,
      event: input.event,
      enabled: true,
      endpoint: { connectionId: input.connectionId, enabled: true },
    },
    select: {
      endpoint: {
        select: { id: true, name: true, productionUrl: true, testUrl: true, testMode: true },
      },
    },
  });
  return subscriptions.map((subscription) => subscription.endpoint);
}

export interface PlannedN8nDeliveries {
  /** Zustellbare Deliveries (PENDING); je eine wird als BullMQ-Job eingereiht. */
  pendingIds: string[];
  /** Bewusst übersprungene Ziele (SKIPPED-Delivery mit Grund). */
  skipped: number;
}

/**
 * Legt je Route eine Delivery mit Ziel-Snapshot an (Zielauswahl über
 * plannedN8nTarget). Fehlt das Signatur-Secret oder ein verlangtes
 * Test-Ziel, entsteht eine SKIPPED-Delivery mit Grund statt eines Jobs.
 */
export async function createPlannedN8nDeliveriesTx(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string;
    outboxId: string;
    connectionId: string;
    endpoints: readonly N8nRouteEndpoint[];
    signingSecretAvailable: boolean;
    mode?: N8nDeliveryMode;
  },
): Promise<PlannedN8nDeliveries> {
  const pendingIds: string[] = [];
  let skipped = 0;
  for (const endpoint of input.endpoints) {
    const target = plannedN8nTarget(endpoint, input.mode);
    const skipReason = input.signingSecretAvailable
      ? target.skipReason
      : 'n8n-Signatur-Secret fehlt';
    const delivery = await tx.n8nDelivery.create({
      data: {
        tenantId: input.tenantId,
        outboxId: input.outboxId,
        endpointId: endpoint.id,
        connectionIdSnapshot: input.connectionId,
        endpointNameSnapshot: endpoint.name,
        targetUrl: target.targetUrl,
        status: skipReason ? 'SKIPPED' : 'PENDING',
        lastError: skipReason,
      },
      select: { id: true },
    });
    if (skipReason) skipped += 1;
    else pendingIds.push(delivery.id);
  }
  return { pendingIds, skipped };
}

export type N8nAggregatedOutboxStatus = 'PENDING' | 'DELIVERED' | 'FAILED' | 'SKIPPED' | 'PARTIAL';

export interface N8nDeliveryAggregateInput {
  status: string;
  lastError: string | null;
  deliveredAt: Date | null;
}

export interface N8nOutboxAggregate {
  status: N8nAggregatedOutboxStatus;
  deliveredAt: Date | null;
  lastError: string | null;
}

/** Outbox-Status aus seinen Fan-out-Deliveries (rein funktional). */
export function aggregateN8nOutboxStatus(
  deliveries: readonly N8nDeliveryAggregateInput[],
): N8nOutboxAggregate {
  const pending = deliveries.some(
    (delivery) => delivery.status === 'PENDING' || delivery.status === 'PROCESSING',
  );
  const allDelivered = deliveries.every((delivery) => delivery.status === 'DELIVERED');
  const allFailed = deliveries.every((delivery) => delivery.status === 'FAILED');
  const allSkipped = deliveries.every((delivery) => delivery.status === 'SKIPPED');
  const status: N8nAggregatedOutboxStatus = pending
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
        (latest, delivery) =>
          delivery.deliveredAt && (!latest || delivery.deliveredAt > latest)
            ? delivery.deliveredAt
            : latest,
        null,
      )
    : null;
  const lastError =
    status === 'DELIVERED'
      ? null
      : (deliveries.find((delivery) => delivery.status === 'FAILED')?.lastError ??
        deliveries.find((delivery) => delivery.status === 'SKIPPED')?.lastError ??
        null);
  return { status, deliveredAt, lastError };
}

/**
 * Aggregiert den Outbox-Status unter Parent-Lock. Serialisiert konkurrierende
 * Terminal-Updates verschiedener Fan-out-Deliveries: Ohne `FOR UPDATE` kann
 * ein älterer PENDING-Snapshot nach einem neueren DELIVERED-Update gewinnen.
 */
export async function aggregateN8nOutboxTx(
  tx: Prisma.TransactionClient,
  outboxId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "n8n_outbox" WHERE "id" = ${outboxId}::uuid FOR UPDATE`;
  const deliveries = await tx.n8nDelivery.findMany({
    where: { outboxId },
    select: { status: true, lastError: true, deliveredAt: true },
  });
  if (deliveries.length === 0) return;
  await tx.n8nOutbox.update({
    where: { id: outboxId },
    data: aggregateN8nOutboxStatus(deliveries),
  });
}
