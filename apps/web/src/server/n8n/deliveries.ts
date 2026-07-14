import type { Prisma } from '@prisma/client';

export interface CancelPendingN8nDeliveriesInput {
  tenantId: string;
  /** Ohne endpointId werden alle offenen Deliveries des Tenants abgebrochen. */
  endpointId?: string;
  reason: string;
}

export interface CancelPendingN8nDeliveriesResult {
  deliveryCount: number;
  outboxIds: string[];
}

export interface AcknowledgedN8nDelivery {
  id: string;
  outboxId: string;
  targetUrl: string | null;
}

export async function aggregateN8nOutbox(
  tx: Prisma.TransactionClient,
  outboxId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "n8n_outbox" WHERE "id" = ${outboxId}::uuid FOR UPDATE`;
  const deliveries = await tx.n8nDelivery.findMany({
    where: { outboxId },
    select: { status: true, lastError: true, deliveredAt: true },
  });
  if (deliveries.length === 0) return;

  const pending = deliveries.some(
    (delivery) => delivery.status === 'PENDING' || delivery.status === 'PROCESSING',
  );
  const allDelivered = deliveries.every((delivery) => delivery.status === 'DELIVERED');
  const allFailed = deliveries.every((delivery) => delivery.status === 'FAILED');
  const allSkipped = deliveries.every((delivery) => delivery.status === 'SKIPPED');
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

  await tx.n8nOutbox.update({
    where: { id: outboxId },
    data: { status, deliveredAt, lastError },
  });
}

/**
 * Bricht noch nicht gestartete Zustellungen vor dem Löschen einer Route oder
 * Connection ab. Der Aufrufer muss Helper und Delete in derselben
 * `withTenantContext`-Transaktion ausführen, damit kein historieloser Zustand
 * sichtbar wird.
 */
export async function cancelPendingN8nDeliveries(
  tx: Prisma.TransactionClient,
  input: CancelPendingN8nDeliveriesInput,
): Promise<CancelPendingN8nDeliveriesResult> {
  const pending = await tx.n8nDelivery.findMany({
    where: {
      tenantId: input.tenantId,
      status: 'PENDING',
      ...(input.endpointId ? { endpointId: input.endpointId } : {}),
    },
    select: { id: true, outboxId: true },
  });
  if (pending.length === 0) return { deliveryCount: 0, outboxIds: [] };

  const reason = input.reason.slice(0, 1_000);
  const updated = await tx.n8nDelivery.updateMany({
    where: {
      tenantId: input.tenantId,
      status: 'PENDING',
      id: { in: pending.map((delivery) => delivery.id) },
    },
    data: {
      status: 'SKIPPED',
      lastError: reason,
      deliveredAt: null,
    },
  });

  const outboxIds = [...new Set(pending.map((delivery) => delivery.outboxId))].sort();
  for (const outboxId of outboxIds) await aggregateN8nOutbox(tx, outboxId);
  return { deliveryCount: updated.count, outboxIds };
}

/**
 * Quittiert ausschließlich einen weiterhin offenen FAILED-Snapshot und
 * aggregiert das Parent-Event unter demselben DB-Lock. Audit/Evidence bleibt
 * beim aufrufenden Admin-Use-Case, aber in derselben Transaktion.
 */
export async function acknowledgeFailedN8nDelivery(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; deliveryId: string },
): Promise<AcknowledgedN8nDelivery | null> {
  const delivery = await tx.n8nDelivery.findFirst({
    where: { id: input.deliveryId, tenantId: input.tenantId, status: 'FAILED' },
    select: { id: true, outboxId: true, lastError: true, targetUrl: true },
  });
  if (!delivery) return null;
  const updated = await tx.n8nDelivery.updateMany({
    where: { id: delivery.id, tenantId: input.tenantId, status: 'FAILED' },
    data: {
      status: 'SKIPPED',
      leaseToken: null,
      leaseExpiresAt: null,
      deliveredAt: null,
      lastError:
        `Administrativ quittiert. Ursprünglicher Fehler: ${delivery.lastError ?? 'nicht angegeben'}`.slice(
          0,
          1_000,
        ),
    },
  });
  if (!updated.count) return null;
  await aggregateN8nOutbox(tx, delivery.outboxId);
  return { id: delivery.id, outboxId: delivery.outboxId, targetUrl: delivery.targetUrl };
}
