// =============================================================================
// n8n-Einstellungen: Workflow-Routen anlegen, ändern, löschen, entdecken und
// testen (Review-Finding K-03).
//
// Ziel-URLs laufen vor dem Speichern und vor jedem Testversand durch die
// SSRF-Prüfung (server/http/ssrf-guard.ts). Synthetische Fach-Events gehen nur
// an die getrennte /webhook-test/-URL; das prüft die Action vor dem Aufruf.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { withTenantContext, type TxClient } from '@taxtronik/db';
import { signOutboundN8n } from '@taxtronik/n8n-shared';
import { ActionError } from '@/server/actions/action-error';
import { isUniqueViolation } from '@/server/actions/database-error';
import { evidenceService } from '@/server/container';
import { safeFetchN8n } from '@/server/http/ssrf-guard';
import { N8nApiClient, type N8nDiscoveredWebhook } from '@/server/n8n/client';
import { cancelPendingN8nDeliveries } from '@/server/n8n/deliveries';
import { connectionPatchForSavedRoute } from '@/server/n8n/route-activation';
import { readN8nConfig } from '@/server/settings/n8n';
import {
  endpointRouteChange,
  joinWebhookUrl,
  pingChallengeOk,
  syntheticN8nTestEvent,
  testWebhookPrefix,
  webhookTargetKind,
  webhookVerificationError,
  type N8nEndpointInput,
} from './validation';
import {
  n8nAdminErrorMessage,
  revalidateN8nSettings,
  validateStoredUrl,
  type N8nAdminContext,
  type N8nSettingsResult,
} from './shared';

/** Webhook-Knoten aus n8n mit den daraus abgeleiteten Routen-URLs. */
export interface N8nDiscoveredWebhookView {
  workflowId: string;
  workflowName: string;
  workflowActive: boolean;
  nodeId: string;
  nodeName: string;
  path: string;
  productionUrl: string;
  testUrl: string;
}

/**
 * Ändert eine bestehende Route optimistisch gesperrt (updatedAt). Ziel- oder
 * Event-Änderungen setzen die Verifikation zurück; zustellrelevante Änderungen
 * brechen wartende Zustellungen der Route ab. Liefert die Zahl der Abbrüche.
 */
async function updateN8nEndpointTx(
  tx: TxClient,
  ctx: N8nAdminContext,
  connectionId: string,
  endpointId: string,
  data: N8nEndpointInput,
): Promise<number> {
  const exists = await tx.n8nWebhookEndpoint.findFirst({
    where: { id: endpointId, tenantId: ctx.tenantId, connectionId },
    select: {
      id: true,
      productionUrl: true,
      testUrl: true,
      enabled: true,
      testMode: true,
      updatedAt: true,
      subscriptions: { select: { event: true } },
    },
  });
  if (!exists) throw new ActionError('Webhook-Route nicht gefunden.');
  const { routeChanged, cancelReason } = endpointRouteChange(exists, data);
  let cancelledPendingDeliveries = 0;
  if (cancelReason) {
    const cancelled = await cancelPendingN8nDeliveries(tx, {
      tenantId: ctx.tenantId,
      endpointId,
      reason: cancelReason,
    });
    cancelledPendingDeliveries = cancelled.deliveryCount;
  }
  const updated = await tx.n8nWebhookEndpoint.updateMany({
    where: { id: endpointId, tenantId: ctx.tenantId, updatedAt: exists.updatedAt },
    data: {
      name: data.name,
      productionUrl: data.productionUrl,
      testUrl: data.testUrl || null,
      workflowId: data.workflowId || null,
      workflowName: data.workflowName || null,
      workflowNodeId: data.workflowNodeId || null,
      enabled: data.enabled,
      testMode: data.testMode,
      ...(routeChanged
        ? {
            verifiedAt: null,
            verificationOk: null,
            verificationError: null,
          }
        : {}),
    },
  });
  if (!updated.count) {
    throw new ActionError(
      'Die Route wurde parallel geändert. Bitte aktuellen Stand laden und erneut speichern.',
    );
  }
  return cancelledPendingDeliveries;
}

/**
 * Route anlegen bzw. ändern, Event-Abos ersetzen, die Verbindung bei Bedarf
 * für explizite Routen freigeben und auditieren — in einer Transaktion.
 */
export async function saveN8nEndpointTx(
  tx: TxClient,
  ctx: N8nAdminContext,
  data: N8nEndpointInput,
): Promise<{ id: string; connectionId: string; connectionActivated: boolean }> {
  const connection = await tx.n8nConnection.findUnique({ where: { tenantId: ctx.tenantId } });
  if (!connection) throw new ActionError('Bitte zuerst die n8n-Verbindung speichern.');

  let endpointId = data.id;
  let cancelledPendingDeliveries = 0;
  if (endpointId) {
    cancelledPendingDeliveries = await updateN8nEndpointTx(
      tx,
      ctx,
      connection.id,
      endpointId,
      data,
    );
  } else {
    const created = await tx.n8nWebhookEndpoint.create({
      data: {
        tenantId: ctx.tenantId,
        connectionId: connection.id,
        name: data.name,
        productionUrl: data.productionUrl,
        testUrl: data.testUrl || null,
        workflowId: data.workflowId || null,
        workflowName: data.workflowName || null,
        workflowNodeId: data.workflowNodeId || null,
        source: data.source,
        enabled: data.enabled,
        testMode: data.testMode,
      },
      select: { id: true },
    });
    endpointId = created.id;
  }

  await tx.n8nEventSubscription.deleteMany({
    where: { endpointId, tenantId: ctx.tenantId },
  });
  await tx.n8nEventSubscription.createMany({
    data: [...new Set(data.events)].map((event) => ({
      tenantId: ctx.tenantId,
      endpointId,
      event,
      enabled: true,
    })),
  });
  const connectionPatch = connectionPatchForSavedRoute({
    connection,
    routeEnabledRequested: data.enabled,
  });
  const connectionActivated = Boolean(
    connectionPatch.enabled &&
    (!connection.enabled || connection.routingMode !== connectionPatch.routingMode),
  );
  await tx.n8nConnection.update({
    where: { id: connection.id },
    data: connectionPatch,
  });
  await evidenceService.record(tx, {
    tenantId: ctx.tenantId,
    actorType: 'STAFF',
    actorId: ctx.actorId,
    action: 'tenant.settings.n8n.endpoint.upsert',
    resourceType: 'n8n_webhook_endpoint',
    resourceId: endpointId,
    after: {
      name: data.name,
      productionUrl: data.productionUrl,
      testUrl: data.testUrl || null,
      enabledRequested: data.enabled,
      enabled: data.enabled,
      testMode: data.testMode,
      events: data.events,
      connectionActivated,
      cancelledPendingDeliveries,
    },
  });
  return {
    id: endpointId,
    connectionId: connection.id,
    connectionActivated,
  };
}

/** Route speichern: SSRF-Prüfung beider Ziel-URLs, dann die Transaktion. */
export async function saveN8nEndpoint(
  ctx: N8nAdminContext,
  data: N8nEndpointInput,
): Promise<N8nSettingsResult> {
  try {
    await Promise.all([
      validateStoredUrl(data.productionUrl, 'webhook'),
      data.testUrl ? validateStoredUrl(data.testUrl, 'webhook-test') : Promise.resolve(),
    ]);
  } catch (error) {
    return { ok: false, error: n8nAdminErrorMessage(error) };
  }

  try {
    const endpoint = await withTenantContext(ctx, (tx) => saveN8nEndpointTx(tx, ctx, data));
    revalidateN8nSettings();
    return {
      ok: true,
      connectionActivated: endpoint.connectionActivated,
      message: endpoint.connectionActivated
        ? 'Workflow-Route gespeichert; n8n ist jetzt für explizite Routen aktiviert.'
        : 'Workflow-Route gespeichert.',
    };
  } catch (error) {
    return {
      ok: false,
      error: isUniqueViolation(error)
        ? 'Eine Route mit diesem Namen existiert bereits.'
        : n8nAdminErrorMessage(error),
    };
  }
}

/** Route entfernen; ihre wartenden Zustellungen werden vorher abgebrochen. */
export async function deleteN8nEndpoint(
  ctx: N8nAdminContext,
  endpointId: string,
): Promise<N8nSettingsResult> {
  const deleted = await withTenantContext(ctx, async (tx) => {
    const cancelled = await cancelPendingN8nDeliveries(tx, {
      tenantId: ctx.tenantId,
      endpointId,
      reason: 'n8n-Route wurde entfernt',
    });
    const result = await tx.n8nWebhookEndpoint.deleteMany({
      where: { id: endpointId, tenantId: ctx.tenantId },
    });
    if (result.count) {
      await evidenceService.record(tx, {
        tenantId: ctx.tenantId,
        actorType: 'STAFF',
        actorId: ctx.actorId,
        action: 'tenant.settings.n8n.endpoint.delete',
        resourceType: 'n8n_webhook_endpoint',
        resourceId: endpointId,
        after: { cancelledPendingDeliveries: cancelled.deliveryCount },
      });
    }
    return result;
  });
  if (!deleted.count) return { ok: false, error: 'Route nicht gefunden.' };
  revalidateN8nSettings();
  return { ok: true, message: 'Route entfernt.' };
}

/** POST-Webhook-Knoten als Routen-Vorschläge (URLs aus dem Produktions-Präfix). */
export function discoveredWebhookViews(
  discovered: readonly N8nDiscoveredWebhook[],
  productionPrefix: string,
): N8nDiscoveredWebhookView[] {
  const testPrefix = productionPrefix ? testWebhookPrefix(productionPrefix) : '';
  return discovered
    .filter((item) => item.httpMethod === 'POST')
    .map((item) => ({
      workflowId: item.workflowId,
      workflowName: item.workflowName,
      workflowActive: item.workflowActive,
      nodeId: item.nodeId,
      nodeName: item.nodeName,
      path: item.path,
      productionUrl: productionPrefix ? joinWebhookUrl(productionPrefix, item.path) : '',
      testUrl: testPrefix ? joinWebhookUrl(testPrefix, item.path) : '',
    }));
}

/** Liest die Webhook-Knoten der n8n-Workflows über die Public API. */
export async function discoverN8nWebhooks(
  ctx: N8nAdminContext,
): Promise<N8nSettingsResult & { webhooks?: N8nDiscoveredWebhookView[] }> {
  const cfg = await readN8nConfig(ctx);
  if (!cfg?.apiBaseUrl || !cfg.apiKey)
    return { ok: false, error: 'n8n-API ist nicht konfiguriert.' };

  try {
    const discovered = await new N8nApiClient(cfg.apiBaseUrl, cfg.apiKey).discoverWebhooks();
    return {
      ok: true,
      message: `${discovered.length} Webhook-Knoten gefunden.`,
      webhooks: discoveredWebhookViews(discovered, cfg.webhookBaseUrl),
    };
  } catch (error) {
    return { ok: false, error: n8nAdminErrorMessage(error) };
  }
}

function routeChangedDuringTest(): N8nSettingsResult {
  return {
    ok: false,
    error: 'Die Route wurde während des Tests geändert. Bitte den aktuellen Stand erneut testen.',
  };
}

/**
 * Speichert das Testergebnis an der Route und als Gesundheitsstatus der
 * Verbindung — nur, wenn die Route seit dem Laden unverändert ist.
 */
async function recordEndpointVerification(
  ctx: N8nAdminContext,
  endpoint: { id: string; connectionId: string; updatedAt: Date },
  ok: boolean,
  error: string | null,
): Promise<boolean> {
  return withTenantContext(ctx, async (tx) => {
    const route = await tx.n8nWebhookEndpoint.updateMany({
      where: { id: endpoint.id, tenantId: ctx.tenantId, updatedAt: endpoint.updatedAt },
      data: {
        verifiedAt: new Date(),
        verificationOk: ok,
        verificationError: error?.slice(0, 500) ?? null,
      },
    });
    if (!route.count) return false;
    await tx.n8nConnection.updateMany({
      where: { id: endpoint.connectionId, tenantId: ctx.tenantId },
      data: {
        healthCheckedAt: new Date(),
        healthOk: ok,
        healthError: error?.slice(0, 500) ?? null,
      },
    });
    return true;
  });
}

/**
 * Sendet ein signiertes synthetisches Event an die Produktions- oder Test-URL
 * einer Route (das Event muss abonniert sein) und hält das Ergebnis fest.
 */
export async function testN8nEndpoint(
  ctx: N8nAdminContext,
  { endpointId, useTestUrl, event }: { endpointId: string; useTestUrl: boolean; event: string },
): Promise<N8nSettingsResult> {
  const cfg = await readN8nConfig(ctx);
  if (!cfg?.hmacSecret) return { ok: false, error: 'Signatur-Secret fehlt.' };

  const endpoint = await withTenantContext(ctx, (tx) =>
    tx.n8nWebhookEndpoint.findFirst({
      where: {
        id: endpointId,
        tenantId: ctx.tenantId,
        subscriptions: { some: { event, enabled: true } },
      },
      select: {
        id: true,
        productionUrl: true,
        testUrl: true,
        connectionId: true,
        updatedAt: true,
      },
    }),
  );
  if (!endpoint) {
    return { ok: false, error: 'Die Route hat dieses Event nicht abonniert.' };
  }
  const targetUrl = useTestUrl ? endpoint.testUrl : endpoint.productionUrl;
  if (!targetUrl) return { ok: false, error: 'Für diese Route ist keine Test-URL hinterlegt.' };

  const eventId = randomUUID();
  const deliveryId = randomUUID();
  const body = syntheticN8nTestEvent({
    eventId,
    deliveryId,
    event,
    tenantId: ctx.tenantId,
    occurredAt: new Date(),
  });
  const signature = signOutboundN8n(event, body, cfg.hmacSecret);
  const started = Date.now();
  try {
    const response = await safeFetchN8n(targetUrl, webhookTargetKind(useTestUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-taxtronik-signature': signature.signature,
        'x-taxtronik-timestamp': signature.timestamp,
        'x-taxtronik-event': signature.event,
        'x-taxtronik-nonce': signature.nonce,
        'x-taxtronik-delivery-id': deliveryId,
      },
      body,
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
    const responseBody = (await response.text()).slice(0, 400);
    const latency = Date.now() - started;
    const challengeOk = pingChallengeOk(event, responseBody);
    const ok = response.ok && challengeOk;
    const verificationError = webhookVerificationError(response, responseBody, challengeOk);
    const verificationRecorded = await recordEndpointVerification(
      ctx,
      endpoint,
      ok,
      verificationError,
    );
    revalidateN8nSettings();
    if (!verificationRecorded) return routeChangedDuringTest();
    return ok
      ? { ok: true, message: `Webhook bestätigt (${latency} ms, HTTP ${response.status}).` }
      : { ok: false, error: verificationError ?? 'Webhook-Prüfung fehlgeschlagen.' };
  } catch (error) {
    const message = n8nAdminErrorMessage(error);
    const verificationRecorded = await recordEndpointVerification(ctx, endpoint, false, message);
    revalidateN8nSettings();
    if (!verificationRecorded) return routeChangedDuringTest();
    return { ok: false, error: message };
  }
}
