// =============================================================================
// n8n-Einstellungen: Zustellungen bedienen — Fehlerliste, Quittieren, Retry,
// Replay und Abschluss nicht zugeordneter Events (Review-Finding K-03).
//
// R-01: Retry und Replay wählen das Ziel über dieselbe API wie Outbox-Planung
// und Worker (plannedN8nTarget); alte Ziel-Snapshots werden nie erneut gesendet.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { withTenantContext, type TxClient } from '@taxtronik/db';
import {
  checkPlannedN8nRoute,
  createPlannedN8nDeliveriesTx,
  findActiveN8nRouteEndpointsTx,
  n8nDeliveryJob,
  n8nRoutingState,
  readN8nDeliveryConfig,
} from '@taxtronik/n8n-shared/outbox-enqueue';
import { evidenceService } from '@/server/container';
import { acknowledgeFailedN8nDelivery, aggregateN8nOutbox } from '@/server/n8n/deliveries';
import { getN8nDeliverQueue } from '@/server/n8n/queue';
import { toN8nRecentDeliveryView, type N8nRecentDeliveryView } from '@/server/n8n/status';
import {
  n8nAdminErrorMessage,
  revalidateN8nSettings,
  type N8nAdminContext,
  type N8nSettingsResult,
} from './shared';

/** Offene Fehler seitenweise (50 je Seite), unabhängig von neueren Erfolgen. */
export async function listFailedN8nDeliveries(
  ctx: N8nAdminContext,
  cursor: string | null,
): Promise<{ ok: true; deliveries: N8nRecentDeliveryView[]; nextCursor: string | null }> {
  const rows = await withTenantContext(ctx, (tx) =>
    tx.n8nDelivery.findMany({
      where: { tenantId: ctx.tenantId, status: 'FAILED' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: 51,
      include: { outbox: { select: { id: true, event: true } } },
    }),
  );
  const deliveries = rows.slice(0, 50).map(toN8nRecentDeliveryView);
  return {
    ok: true,
    deliveries,
    nextCursor: rows.length > 50 ? (deliveries.at(-1)?.id ?? null) : null,
  };
}

/**
 * Schließt einen bewusst nicht mehr zustellbaren Altfehler administrativ ab.
 * Die Payload bleibt bis zur regulären Retention erhalten; nur der operative
 * Fehlerstatus wechselt revisionsprotokolliert zu SKIPPED.
 */
export async function acknowledgeN8nDelivery(
  ctx: N8nAdminContext,
  deliveryId: string,
): Promise<N8nSettingsResult> {
  const acknowledged = await withTenantContext(ctx, async (tx) => {
    const delivery = await acknowledgeFailedN8nDelivery(tx, {
      tenantId: ctx.tenantId,
      deliveryId,
    });
    if (!delivery) return false;
    await evidenceService.record(tx, {
      tenantId: ctx.tenantId,
      actorType: 'STAFF',
      actorId: ctx.actorId,
      action: 'tenant.settings.n8n.delivery.acknowledge',
      resourceType: 'n8n_delivery',
      resourceId: delivery.id,
      after: {
        status: 'SKIPPED',
        outboxId: delivery.outboxId,
        targetUrl: delivery.targetUrl,
        reason: 'operator_acknowledged',
      },
    });
    return true;
  });
  if (!acknowledged) {
    return { ok: false, error: 'Nur offene fehlgeschlagene Zustellungen können quittiert werden.' };
  }
  revalidateN8nSettings();
  return { ok: true, message: 'Fehler wurde revisionsprotokolliert quittiert.' };
}

type RetryReset =
  | { kind: 'missing' }
  | { kind: 'stale' }
  | { kind: 'ready'; id: string; outboxId: string };

/**
 * Setzt eine fehlgeschlagene Zustellung auf PENDING zurück, wenn ihr
 * Ziel-Snapshot noch der aktuellen Route entspricht.
 */
export async function resetFailedN8nDeliveryTx(
  tx: TxClient,
  ctx: N8nAdminContext,
  deliveryId: string,
): Promise<RetryReset> {
  const delivery = await tx.n8nDelivery.findFirst({
    where: { id: deliveryId, tenantId: ctx.tenantId, status: 'FAILED' },
    select: {
      id: true,
      outboxId: true,
      targetUrl: true,
      connectionIdSnapshot: true,
      outbox: { select: { event: true } },
      endpoint: {
        select: {
          id: true,
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
  if (!delivery) return { kind: 'missing' as const };
  // R-01: dieselbe Snapshot-Prüfung wie der Worker unmittelbar vor dem
  // Versand — Zielauswahl über plannedN8nTarget, also auch für Routen im
  // testMode. Manuell wiederholt werden nur explizite Routen.
  const routing = n8nRoutingState(await readN8nDeliveryConfig(tx, ctx.tenantId));
  const route = delivery.endpoint
    ? checkPlannedN8nRoute(
        {
          targetUrl: delivery.targetUrl,
          connectionIdSnapshot: delivery.connectionIdSnapshot,
          event: delivery.outbox.event,
          endpoint: delivery.endpoint,
        },
        routing,
      )
    : null;
  if (!route?.ok) return { kind: 'stale' as const };
  await tx.n8nDelivery.update({
    where: { id: delivery.id },
    data: {
      status: 'PENDING',
      httpStatus: null,
      latencyMs: null,
      lastError: null,
      deliveredAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
  await aggregateN8nOutbox(tx, delivery.outboxId);
  await evidenceService.record(tx, {
    tenantId: ctx.tenantId,
    actorType: 'STAFF',
    actorId: ctx.actorId,
    action: 'tenant.settings.n8n.delivery.retry',
    resourceType: 'n8n_delivery',
    resourceId: delivery.id,
    after: {
      outboxId: delivery.outboxId,
      event: delivery.outbox.event,
      targetUrl: delivery.targetUrl,
    },
  });
  return { kind: 'ready' as const, id: delivery.id, outboxId: delivery.outboxId };
}

/** Manueller Retry: zurücksetzen, dann einreihen; scheitert die Queue, wieder FAILED. */
export async function retryN8nDelivery(
  ctx: N8nAdminContext,
  deliveryId: string,
): Promise<N8nSettingsResult> {
  const reset = await withTenantContext(ctx, (tx) => resetFailedN8nDeliveryTx(tx, ctx, deliveryId));
  if (reset.kind === 'missing')
    return { ok: false, error: 'Nur fehlgeschlagene Zustellungen können erneut versucht werden.' };
  if (reset.kind === 'stale') {
    return {
      ok: false,
      error:
        'Das ursprüngliche Ziel wurde geändert, deaktiviert oder entfernt. Alte Ziel-Snapshots werden nicht erneut gesendet.',
    };
  }

  try {
    const job = n8nDeliveryJob(reset.id, { kind: 'manual-retry', nonce: randomUUID() });
    await getN8nDeliverQueue().add(job.name, job.data, job.opts);
  } catch (error) {
    await withTenantContext(ctx, async (tx) => {
      await tx.n8nDelivery.updateMany({
        where: { id: reset.id, tenantId: ctx.tenantId, status: 'PENDING' },
        data: {
          status: 'FAILED',
          lastError: `Retry konnte nicht eingeplant werden: ${n8nAdminErrorMessage(error)}`.slice(
            0,
            1_000,
          ),
        },
      });
      await aggregateN8nOutbox(tx, reset.outboxId);
    });
    revalidateN8nSettings();
    return { ok: false, error: 'Retry konnte nicht in die Queue eingereiht werden.' };
  }

  revalidateN8nSettings();
  return { ok: true, message: 'Zustellung wurde erneut eingeplant.' };
}

type UnroutedReplay =
  | { kind: 'missing' }
  | { kind: 'configuration' }
  | { kind: 'routes' }
  | { kind: 'replayed'; pendingIds: string[]; total: number; skipped: number };

/**
 * Ordnet ein UNROUTED-Event den jetzt aktiven Routen zu (Claim in derselben
 * Transaktion) und legt die geplanten Zustellungen an.
 */
export async function replayUnroutedN8nEventTx(
  tx: TxClient,
  ctx: N8nAdminContext,
  outboxId: string,
): Promise<UnroutedReplay> {
  const outbox = await tx.n8nOutbox.findFirst({
    where: { id: outboxId, tenantId: ctx.tenantId, status: 'UNROUTED' },
    select: { id: true, event: true },
  });
  if (!outbox) return { kind: 'missing' as const };

  const config = await readN8nDeliveryConfig(tx, ctx.tenantId);
  const routing = n8nRoutingState(config);
  const connection = config.connection;
  if (
    !connection ||
    routing.disabled ||
    routing.routingMode !== 'EXPLICIT' ||
    !routing.signingSecretAvailable
  ) {
    return { kind: 'configuration' as const };
  }

  const endpoints = await findActiveN8nRouteEndpointsTx(tx, {
    tenantId: ctx.tenantId,
    event: outbox.event,
    connectionId: connection.id,
  });
  if (endpoints.length === 0) return { kind: 'routes' as const };

  // Claim innerhalb derselben Transaktion: parallele Klicks dürfen nie zwei
  // Delivery-Sätze für dasselbe historische Event erzeugen.
  const claimed = await tx.n8nOutbox.updateMany({
    where: { id: outbox.id, tenantId: ctx.tenantId, status: 'UNROUTED' },
    data: { status: 'PENDING', lastError: null },
  });
  if (!claimed.count) return { kind: 'missing' as const };

  // R-01: dieselbe Zielauswahl wie bei der Erstplanung (plannedN8nTarget) —
  // eine Route im testMode erhält ihre Test-URL. Vorher entstand hier eine
  // Delivery mit Produktions-URL, die der Worker als „Ziel geändert" verwarf.
  const { pendingIds, skipped } = await createPlannedN8nDeliveriesTx(tx, {
    tenantId: ctx.tenantId,
    outboxId: outbox.id,
    connectionId: connection.id,
    endpoints,
    signingSecretAvailable: routing.signingSecretAvailable,
  });

  if (pendingIds.length === 0) {
    await tx.n8nOutbox.update({
      where: { id: outbox.id },
      data: {
        status: 'SKIPPED',
        lastError: 'Alle neu zugeordneten n8n-Zustellungen wurden übersprungen',
      },
    });
  }
  await evidenceService.record(tx, {
    tenantId: ctx.tenantId,
    actorType: 'STAFF',
    actorId: ctx.actorId,
    action: 'tenant.settings.n8n.event.replay',
    resourceType: 'n8n_outbox',
    resourceId: outbox.id,
    after: {
      event: outbox.event,
      deliveriesCreated: endpoints.length,
      skipped,
    },
  });
  return { kind: 'replayed' as const, pendingIds, total: endpoints.length, skipped };
}

/** Ordnet ein historisches UNROUTED-Event bewusst den jetzt aktiven Routen zu. */
export async function replayUnroutedN8nEvent(
  ctx: N8nAdminContext,
  outboxId: string,
): Promise<N8nSettingsResult> {
  const replay = await withTenantContext(ctx, (tx) => replayUnroutedN8nEventTx(tx, ctx, outboxId));

  if (replay.kind === 'missing') {
    return { ok: false, error: 'Das Event ist nicht mehr offen oder wurde bereits zugeordnet.' };
  }
  if (replay.kind === 'configuration') {
    return {
      ok: false,
      error: 'Explizites Routing muss aktiv sein und ein Signatur-Secret enthalten.',
    };
  }
  if (replay.kind === 'routes') {
    return { ok: false, error: 'Für dieses Event ist weiterhin keine aktive Route vorhanden.' };
  }

  let queueFailures = 0;
  for (const deliveryId of replay.pendingIds) {
    try {
      const job = n8nDeliveryJob(deliveryId);
      await getN8nDeliverQueue().add(job.name, job.data, job.opts);
    } catch {
      // Der Reconcile-Job nimmt persistierte PENDING-Deliveries wieder auf.
      queueFailures += 1;
    }
  }
  revalidateN8nSettings();
  return {
    ok: true,
    message:
      queueFailures > 0
        ? `${replay.total} Ziel(e) zugeordnet; ${queueFailures} warten auf automatische Queue-Reconciliation.`
        : `${replay.total} Ziel(e) zugeordnet${replay.skipped ? `, ${replay.skipped} übersprungen` : ''}.`,
  };
}

/** Schließt ein UNROUTED-Event nach bewusster Admin-Entscheidung ohne Versand ab. */
export async function skipUnroutedN8nEvent(
  ctx: N8nAdminContext,
  outboxId: string,
): Promise<N8nSettingsResult> {
  const skipped = await withTenantContext(ctx, async (tx) => {
    const outbox = await tx.n8nOutbox.findFirst({
      where: { id: outboxId, tenantId: ctx.tenantId, status: 'UNROUTED' },
      select: { id: true, event: true, occurredAt: true },
    });
    if (!outbox) return null;
    const claimed = await tx.n8nOutbox.updateMany({
      where: { id: outbox.id, tenantId: ctx.tenantId, status: 'UNROUTED' },
      data: {
        status: 'SKIPPED',
        lastError: 'Durch Admin-Entscheidung ohne n8n-Versand abgeschlossen',
      },
    });
    if (!claimed.count) return null;
    const delivery = await tx.n8nDelivery.create({
      data: {
        tenantId: ctx.tenantId,
        outboxId: outbox.id,
        endpointNameSnapshot: 'Ohne Versand abgeschlossen',
        targetUrl: null,
        status: 'SKIPPED',
        lastError: 'Durch Admin-Entscheidung ohne n8n-Versand abgeschlossen',
      },
      select: { id: true },
    });
    await evidenceService.record(tx, {
      tenantId: ctx.tenantId,
      actorType: 'STAFF',
      actorId: ctx.actorId,
      action: 'tenant.settings.n8n.event.skip',
      resourceType: 'n8n_outbox',
      resourceId: outbox.id,
      after: {
        event: outbox.event,
        occurredAt: outbox.occurredAt.toISOString(),
        deliveryId: delivery.id,
        decision: 'skip_without_delivery',
      },
    });
    return outbox;
  });
  if (!skipped) {
    return { ok: false, error: 'Das Event ist nicht mehr offen oder wurde bereits bearbeitet.' };
  }
  revalidateN8nSettings();
  return { ok: true, message: 'Event wurde nachvollziehbar ohne Versand abgeschlossen.' };
}
