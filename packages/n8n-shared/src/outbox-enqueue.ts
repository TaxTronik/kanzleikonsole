// =============================================================================
// n8n-Outbox + workflow-spezifische Deliveries — geteilter Kern (Web + Worker)
//
// Ein Outbox-Datensatz ist das logische Ereignis. Die Zielauflösung passiert
// atomar beim Schreiben und erzeugt pro explizit abonnierendem Endpoint eine
// eigene Delivery. BullMQ transportiert nur deren ID. Damit sind Fan-out,
// unabhängige Retries und ein ehrlicher Zustellstatus möglich.
//
// Vormals komplett in apps/web/src/server/n8n/outbox.ts. Prozess-spezifische
// Infrastruktur kommt per Dependency-Injection (Muster packages/tax):
//   - db:              Owner-Client mit $transaction (Web + Worker teilen den
//                      prismaOwner aus @taxtronik/db)
//   - enqueueDelivery: BullMQ-Add — Web deckelt mit withTimeout(2s), der
//                      Worker besitzt die n8n-deliver-Queue direkt.
//   - log:             pino des jeweiligen Prozesses.
// env/deliveryMode kommen direkt aus @taxtronik/config (in beiden Prozessen
// vorhanden). WICHTIG: Subpath-Import (`@taxtronik/n8n-shared/outbox-enqueue`)
// verwenden — bestehende Tests mocken den Paket-Index.
//
// R-01: Zielauswahl, Secret-Vorrang, Job-Optionen, Routenprüfung und
// Aggregation leben in routing.ts/deliveries.ts und werden hier für Web-Actions
// und Worker mit exportiert — eine API statt drei Kopien.
// =============================================================================

import type { Prisma } from '@prisma/client';
import { isAllowedN8nEvent, type N8nEventName } from './index';
import {
  createPlannedN8nDeliveriesTx,
  findActiveN8nRouteEndpointsTx,
  readN8nDeliveryConfig,
} from './deliveries';
import {
  hasN8nSigningSecret,
  isN8nConnectionDisabled,
  legacyN8nTargetUrl,
  type N8nRoutingConnection,
} from './routing';

export * from './routing';
export * from './deliveries';

export interface OutboxLogger {
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface OutboxEnqueueDeps {
  /** Owner-Client (BYPASSRLS) — die Zielauflösung läuft in EINER Transaktion. */
  db: { $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> };
  /**
   * Reiht den BullMQ-Job für eine Delivery ein (`n8nDeliveryJob(id)`: jobId
   * `delivery-<id>` + DELIVERY_JOB_OPTIONS setzt der Adapter). Wirft bei
   * Fehlern — der Kern loggt und zählt sie; der Reconcile-Job sammelt stuck
   * PENDING später ein.
   */
  enqueueDelivery: (deliveryId: string) => Promise<unknown>;
  log: OutboxLogger;
}

export type N8nEnqueueStatus =
  | 'PENDING'
  | 'UNROUTED'
  | 'SKIPPED'
  | 'DUPLICATE'
  | 'INVALID_EVENT'
  | 'WRITE_FAILED';

export interface N8nEnqueueResult {
  /** ID des persistierten Outbox-Events; bei Validierungs-/DB-Fehlern null. */
  eventId: string | null;
  status: N8nEnqueueStatus;
  /** Alle erzeugten Delivery-Reihen, einschließlich bewusst übersprungener Ziele. */
  deliveryCount: number;
  error?: string;
}

interface RoutingPlan {
  outboxId: string;
  status: 'PENDING' | 'UNROUTED' | 'SKIPPED' | 'DUPLICATE';
  deliveryCount: number;
  deliveryIds: string[];
  error?: string;
}

async function readExistingDedupeResult(
  deps: OutboxEnqueueDeps,
  dedupeKey: string | null,
): Promise<N8nEnqueueResult | null> {
  if (!dedupeKey) return null;
  const existing = await deps.db.$transaction((tx) =>
    tx.n8nOutbox.findUnique({
      where: { dedupeKey },
      select: {
        id: true,
        status: true,
        lastError: true,
        _count: { select: { deliveries: true } },
      },
    }),
  );
  if (!existing) return null;
  // Ein wiederholter Emit darf ein ursprünglich nicht geroutetes oder bewusst
  // übersprungenes Event nicht durch das bloße Dedupe als erfolgreichen
  // Handoff ausgeben. Nach einem Admin-Replay steht der Outbox-Satz wieder auf
  // PENDING und wird beim nächsten Retry korrekt als DUPLICATE bestätigt.
  if (existing.status === 'UNROUTED' || existing.status === 'SKIPPED') {
    return {
      eventId: existing.id,
      status: existing.status,
      deliveryCount: existing._count.deliveries,
      ...(existing.lastError ? { error: existing.lastError } : {}),
    };
  }
  return {
    eventId: existing.id,
    status: 'DUPLICATE',
    deliveryCount: existing._count.deliveries,
  };
}

async function planExplicitDeliveriesTx(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string;
    event: N8nEventName;
    connection: N8nRoutingConnection;
    signingSecretAvailable: boolean;
    outboxId: string;
  },
  markWithoutDelivery: (
    status: 'UNROUTED' | 'SKIPPED',
    reason: string,
    createSkippedDelivery?: boolean,
  ) => Promise<RoutingPlan>,
): Promise<RoutingPlan> {
  const { tenantId, event, connection, outboxId } = input;
  const endpoints = await findActiveN8nRouteEndpointsTx(tx, {
    tenantId,
    event,
    connectionId: connection.id,
  });
  if (endpoints.length === 0) {
    const configuredSubscriptions = await tx.n8nEventSubscription.count({
      where: {
        tenantId,
        event,
        endpoint: { connectionId: connection.id },
      },
    });
    if (configuredSubscriptions === 0) {
      return markWithoutDelivery(
        'SKIPPED',
        `Event '${event}' ist für n8n nicht abonniert; Webhook-Route speichern und aktivieren`,
      );
    }
    return markWithoutDelivery(
      'UNROUTED',
      `Konfigurierte n8n-Route für Event '${event}' ist nicht aktiv`,
    );
  }

  // Sobald eine normalisierte Connection existiert, ist sie alleinige
  // Secret-Quelle (n8nDeliveryConfigFrom). Test-Ziel global
  // (N8N_DELIVERY_MODE=test) oder per Route-Debug-Schalter testMode
  // (plannedN8nTarget) — beides liefert an /webhook-test.
  const planned = await createPlannedN8nDeliveriesTx(tx, {
    tenantId,
    outboxId,
    connectionId: connection.id,
    endpoints,
    signingSecretAvailable: input.signingSecretAvailable,
  });

  const allSkipped = planned.pendingIds.length === 0;
  if (allSkipped) {
    await tx.n8nOutbox.update({
      where: { id: outboxId },
      data: { status: 'SKIPPED', lastError: 'Alle n8n-Zustellungen wurden übersprungen' },
    });
  }
  return {
    outboxId,
    status: allSkipped ? 'SKIPPED' : 'PENDING',
    deliveryCount: endpoints.length,
    deliveryIds: planned.pendingIds,
    ...(allSkipped ? { error: 'Alle n8n-Zustellungen wurden übersprungen' } : {}),
  } satisfies RoutingPlan;
}

export async function enqueueN8nEventCore(
  deps: OutboxEnqueueDeps,
  event: N8nEventName,
  payload: Record<string, unknown>,
  opts: { tenantId?: string; dedupeKey?: string } = {},
): Promise<N8nEnqueueResult> {
  const { log } = deps;
  if (!isAllowedN8nEvent(event)) {
    log.error({ component: 'n8n-outbox', event }, 'event not in whitelist — refusing to enqueue');
    return {
      eventId: null,
      status: 'INVALID_EVENT',
      deliveryCount: 0,
      error: `Event '${event}' ist nicht freigegeben`,
    };
  }

  const tenantId = opts.tenantId ?? null;
  const dedupeKey = opts.dedupeKey?.trim() || null;
  if (dedupeKey && dedupeKey.length > 200) {
    return {
      eventId: null,
      status: 'WRITE_FAILED',
      deliveryCount: 0,
      error: 'n8n-Dedupe-Key ist zu lang',
    };
  }
  let planned: RoutingPlan;

  try {
    const duplicate = await readExistingDedupeResult(deps, dedupeKey);
    if (duplicate) return duplicate;
    planned = await deps.db.$transaction(async (tx) => {
      const outbox = await tx.n8nOutbox.create({
        data: { tenantId, event, payload: payload as object, dedupeKey },
        select: { id: true },
      });
      // Legacy-Konfiguration wird nur gelesen, wenn noch keine normalisierte
      // Connection existiert; ENV gilt nur ohne Connection UND ohne Legacy-
      // Eintrag. So kann weder eine alte Tenant-Einstellung noch ENV eine
      // unvollständige/rotierte Konfiguration unbemerkt ergänzen.
      const config = await readN8nDeliveryConfig(tx, tenantId);
      const connection = config.connection;
      const signingSecretAvailable = hasN8nSigningSecret(config.secretSource);

      const markWithoutDelivery = async (
        status: 'UNROUTED' | 'SKIPPED',
        reason: string,
        createSkippedDelivery = false,
      ) => {
        if (createSkippedDelivery) {
          await tx.n8nDelivery.create({
            data: {
              tenantId,
              outboxId: outbox.id,
              connectionIdSnapshot: connection?.id ?? null,
              endpointNameSnapshot: connection?.name ?? 'n8n',
              targetUrl: null,
              status: 'SKIPPED',
              lastError: reason,
            },
          });
        }
        await tx.n8nOutbox.update({
          where: { id: outbox.id },
          data: { status, lastError: reason },
        });
        return {
          outboxId: outbox.id,
          status,
          deliveryCount: createSkippedDelivery ? 1 : 0,
          deliveryIds: [],
          error: reason,
        } satisfies RoutingPlan;
      };

      if (connection && isN8nConnectionDisabled(connection)) {
        return markWithoutDelivery('SKIPPED', 'n8n-Integration bewusst deaktiviert', true);
      }

      if (connection?.routingMode === 'EXPLICIT') {
        // Eine Connection kann nur bei vorhandenem Tenant geladen werden.
        return planExplicitDeliveriesTx(
          tx,
          {
            tenantId: tenantId as string,
            event,
            connection,
            signingSecretAvailable,
            outboxId: outbox.id,
          },
          markWithoutDelivery,
        );
      }

      // Eine normalisierte LEGACY-Connection verwendet ebenfalls ausschließlich
      // ihre eigenen Felder. tenant_setting/ENV gelten nur ohne Connection.
      const legacyBase = config.legacyWebhookBaseUrl;
      if (!legacyBase || !signingSecretAvailable) {
        return markWithoutDelivery('SKIPPED', 'n8n nicht vollständig konfiguriert', true);
      }

      const delivery = await tx.n8nDelivery.create({
        data: {
          tenantId,
          outboxId: outbox.id,
          connectionIdSnapshot: connection?.id ?? null,
          endpointNameSnapshot: connection?.name
            ? `${connection.name} (Legacy)`
            : `Legacy: ${event}`,
          targetUrl: legacyN8nTargetUrl(legacyBase, event),
        },
        select: { id: true },
      });
      return {
        outboxId: outbox.id,
        status: 'PENDING',
        deliveryCount: 1,
        deliveryIds: [delivery.id],
      } satisfies RoutingPlan;
    });
  } catch (err) {
    // Zwei parallele Aufrufer desselben stabilen Dedupe-Keys können beide
    // den Vorab-Read passieren. Der Unique-Backstop gewinnt; der Verlierer
    // liest den bereits dauerhaft geschriebenen Outbox-Eintrag zurück und ist
    // damit kein WRITE_FAILED/Retry-Fehler.
    if (dedupeKey && (err as { code?: string }).code === 'P2002') {
      // Derselbe statusbewahrende Read wie im Fast-Path: Gewinnt der
      // parallele Aufrufer mit UNROUTED/SKIPPED, darf der Verlierer das nicht
      // als erfolgreichen DUPLICATE-Handoff ausgeben.
      const existing = await readExistingDedupeResult(deps, dedupeKey);
      if (existing) return existing;
    }
    log.error({ component: 'n8n-outbox', event, err: (err as Error).message }, 'write failed');
    return {
      eventId: null,
      status: 'WRITE_FAILED',
      deliveryCount: 0,
      error: 'n8n-Outbox konnte nicht geschrieben werden',
    };
  }

  const enqueueResults = await Promise.all(
    planned.deliveryIds.map(async (deliveryId) => {
      try {
        await deps.enqueueDelivery(deliveryId);
        return true;
      } catch (err) {
        log.error(
          {
            component: 'n8n-outbox',
            event,
            outboxId: planned.outboxId,
            deliveryId,
            err: (err as Error).message,
          },
          'enqueue failed — PENDING delivery will be picked up by reconcile job',
        );
        return false;
      }
    }),
  );
  const failedQueueAdds = enqueueResults.filter((queued) => !queued).length;
  return {
    eventId: planned.outboxId,
    status: planned.status,
    deliveryCount: planned.deliveryCount,
    ...(planned.error ? { error: planned.error } : {}),
    ...(failedQueueAdds > 0
      ? {
          error: `${failedQueueAdds} Delivery-Job(s) warten auf die automatische Reconciliation`,
        }
      : {}),
  };
}
