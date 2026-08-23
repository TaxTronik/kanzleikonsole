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
// =============================================================================

import { env, n8nDeliveryMode } from '@taxtronik/config';
import type { Prisma } from '@prisma/client';
import { isAllowedN8nEvent, type N8nEventName } from './index';

export const DELIVERY_JOB_OPTIONS = {
  attempts: 6,
  backoff: { type: 'exponential' as const, delay: 60_000 },
  removeOnComplete: { age: 24 * 60 * 60 },
  removeOnFail: { age: 7 * 24 * 60 * 60 },
};

export interface OutboxLogger {
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface OutboxEnqueueDeps {
  /** Owner-Client (BYPASSRLS) — die Zielauflösung läuft in EINER Transaktion. */
  db: { $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> };
  /**
   * Reiht den BullMQ-Job für eine Delivery ein (jobId `delivery-<id>` +
   * DELIVERY_JOB_OPTIONS setzt der Adapter). Wirft bei Fehlern — der Kern
   * loggt und zählt sie; der Reconcile-Job sammelt stuck PENDING später ein.
   */
  enqueueDelivery: (deliveryId: string) => Promise<unknown>;
  log: OutboxLogger;
}

interface LegacyStoredConfig {
  webhookBaseUrl?: string;
  hmacEncrypted?: string;
  hmacSecret?: string;
}

interface LegacyConfigHint {
  webhookBaseUrl: string;
  secretConfigured: boolean;
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

function legacyTargetUrl(baseUrl: string, event: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const modeBase = n8nDeliveryMode === 'test' ? base.replace(/\/webhook$/, '/webhook-test') : base;
  return `${modeBase}/${encodeURIComponent(event)}`;
}

async function readLegacyConfigHint(
  tx: Prisma.TransactionClient,
  tenantId: string | null,
): Promise<LegacyConfigHint> {
  let stored: LegacyStoredConfig | null = null;
  if (tenantId) {
    const row = await tx.tenantSetting.findUnique({
      where: { tenantId_key: { tenantId, key: 'integrations.n8n' } },
      select: { value: true },
    });
    stored = row ? (row.value as LegacyStoredConfig) : null;
  }
  return {
    webhookBaseUrl: stored?.webhookBaseUrl?.trim() || env.N8N_WEBHOOK_BASE_URL || '',
    secretConfigured: Boolean(stored?.hmacEncrypted || stored?.hmacSecret || env.N8N_HMAC_SECRET),
  };
}

async function readExistingDedupeResult(
  deps: OutboxEnqueueDeps,
  dedupeKey: string | null,
): Promise<N8nEnqueueResult | null> {
  if (!dedupeKey) return null;
  const existing = await deps.db.$transaction((tx) =>
    tx.n8nOutbox.findUnique({
      where: { dedupeKey },
      select: { id: true, _count: { select: { deliveries: true } } },
    }),
  );
  return existing
    ? {
        eventId: existing.id,
        status: 'DUPLICATE',
        deliveryCount: existing._count.deliveries,
      }
    : null;
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
      const connection = tenantId
        ? await tx.n8nConnection.findUnique({
            where: { tenantId },
            select: {
              id: true,
              name: true,
              enabled: true,
              routingMode: true,
              webhookBaseUrl: true,
              signingSecretEncrypted: true,
            },
          })
        : null;
      // Legacy-Konfiguration wird nur gelesen, wenn noch keine normalisierte
      // Connection existiert. So kann weder eine alte Tenant-Einstellung noch
      // ENV eine unvollständige/rotierte Connection unbemerkt ergänzen.
      const legacy = connection ? null : await readLegacyConfigHint(tx, tenantId);

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

      if (connection && (!connection.enabled || connection.routingMode === 'DISABLED')) {
        return markWithoutDelivery('SKIPPED', 'n8n-Integration bewusst deaktiviert', true);
      }

      if (connection?.routingMode === 'EXPLICIT') {
        // Eine Connection kann nur bei vorhandenem Tenant geladen werden.
        const explicitTenantId = tenantId as string;
        const subscriptions = await tx.n8nEventSubscription.findMany({
          where: {
            tenantId: explicitTenantId,
            event,
            enabled: true,
            endpoint: { connectionId: connection.id, enabled: true },
          },
          select: {
            endpoint: {
              select: { id: true, name: true, productionUrl: true, testUrl: true, testMode: true },
            },
          },
        });
        if (subscriptions.length === 0) {
          const configuredSubscriptions = await tx.n8nEventSubscription.count({
            where: {
              tenantId: explicitTenantId,
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
        // Secret-Quelle. Ein stiller Fallback auf tenant_setting/ENV würde ein
        // bewusst gelöschtes oder rotiertes Secret wieder aktivieren.
        const secretConfigured = Boolean(connection.signingSecretEncrypted);
        const deliveryIds: string[] = [];
        let pending = 0;
        for (const { endpoint } of subscriptions) {
          // Test-Ziel entweder global (N8N_DELIVERY_MODE=test) oder pro Route
          // über den Debug-Schalter testMode — beides liefert an /webhook-test.
          const useTestUrl = n8nDeliveryMode === 'test' || endpoint.testMode;
          const targetUrl = useTestUrl ? endpoint.testUrl : endpoint.productionUrl;
          const skipReason = !secretConfigured
            ? 'n8n-Signatur-Secret fehlt'
            : useTestUrl && !targetUrl
              ? 'Kein sicherer n8n-Test-Webhook für diesen Endpoint konfiguriert'
              : null;
          const delivery = await tx.n8nDelivery.create({
            data: {
              tenantId,
              outboxId: outbox.id,
              endpointId: endpoint.id,
              connectionIdSnapshot: connection.id,
              endpointNameSnapshot: endpoint.name,
              targetUrl: targetUrl ?? null,
              status: skipReason ? 'SKIPPED' : 'PENDING',
              lastError: skipReason,
            },
            select: { id: true },
          });
          if (!skipReason) {
            pending += 1;
            deliveryIds.push(delivery.id);
          }
        }

        const allSkipped = pending === 0;
        if (allSkipped) {
          await tx.n8nOutbox.update({
            where: { id: outbox.id },
            data: { status: 'SKIPPED', lastError: 'Alle n8n-Zustellungen wurden übersprungen' },
          });
        }
        return {
          outboxId: outbox.id,
          status: allSkipped ? 'SKIPPED' : 'PENDING',
          deliveryCount: subscriptions.length,
          deliveryIds,
          ...(allSkipped ? { error: 'Alle n8n-Zustellungen wurden übersprungen' } : {}),
        } satisfies RoutingPlan;
      }

      // Eine normalisierte LEGACY-Connection verwendet ebenfalls ausschließlich
      // ihre eigenen Felder. tenant_setting/ENV gelten nur ohne Connection.
      const legacyBase = connection
        ? connection.webhookBaseUrl?.trim() || ''
        : legacy?.webhookBaseUrl || '';
      const secretConfigured = connection
        ? Boolean(connection.signingSecretEncrypted)
        : Boolean(legacy?.secretConfigured);
      if (!legacyBase || !secretConfigured) {
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
          targetUrl: legacyTargetUrl(legacyBase, event),
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
      const existing = await deps.db.$transaction((tx) =>
        tx.n8nOutbox.findUnique({
          where: { dedupeKey },
          select: { id: true, _count: { select: { deliveries: true } } },
        }),
      );
      if (existing) {
        return {
          eventId: existing.id,
          status: 'DUPLICATE',
          deliveryCount: existing._count.deliveries,
        };
      }
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
