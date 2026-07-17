'use server';

import { randomBytes, randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { env, n8nDeliveryMode } from '@taxtronik/config';
import { withTenantContext } from '@taxtronik/db';
import {
  isAllowedN8nEvent,
  N8N_EVENT_CATALOG,
  requiresSeparateTestWebhook,
  signOutboundN8n,
} from '@taxtronik/n8n-shared';
import { safeFetch } from '@taxtronik/http-utils';
import { staffActionGuard } from '@/server/actions/staff-action';
import { evidenceService } from '@/server/container';
import { assertPublicHost } from '@/server/http/ssrf-guard';
import {
  BUNDLED_N8N_WORKFLOWS,
  materializeBundledN8nWorkflow,
  unresolvedBundledN8nPlaceholders,
} from '@/server/n8n/bundled-workflows';
import { N8nApiClient } from '@/server/n8n/client';
import { getN8nDeliverQueue } from '@/server/n8n/queue';
import {
  defaultN8nCallbackBase,
  N8N_CALLBACK_SCOPES,
  readN8nConfig,
  resolveN8nConfig,
  writeN8nConfigTx,
  type N8nConfig,
} from '@/server/settings/n8n';
import { readSmtpConfig } from '@/server/settings/smtp';
import {
  acknowledgeFailedN8nDelivery,
  aggregateN8nOutbox,
  cancelPendingN8nDeliveries,
} from '@/server/n8n/deliveries';
import { rotateN8nCallbackCredential } from '@/server/n8n/callback-credentials';
import { toN8nRecentDeliveryView, type N8nRecentDeliveryView } from '@/server/n8n/status';

export interface ActionResult {
  ok: boolean;
  error?: string;
  message?: string;
}

export interface N8nFailedDeliveryPageResult extends ActionResult {
  deliveries?: N8nRecentDeliveryView[];
  nextCursor?: string | null;
}

const HttpUrl = z
  .string()
  .url()
  .max(1_000)
  .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), {
    message: 'Es sind nur HTTP- und HTTPS-Adressen erlaubt.',
  });
const OptionalUrl = z.union([z.literal(''), HttpUrl]);
const ProductionWebhookUrl = HttpUrl.refine((value) => {
  try {
    const path = decodeURIComponent(new URL(value).pathname).toLowerCase();
    return !/(^|\/)webhook-test(?:\/|$)/.test(path);
  } catch {
    return false;
  }
}, 'Die Produktions-URL darf keine n8n-Test-URL (/webhook-test/) sein.');
const TestWebhookUrl = HttpUrl.refine((value) => {
  try {
    const path = decodeURIComponent(new URL(value).pathname).toLowerCase();
    return /(^|\/)webhook-test(?:\/|$)/.test(path);
  } catch {
    return false;
  }
}, 'Die Test-URL muss eine getrennte n8n-Test-URL mit /webhook-test/ sein.');
const ConnectionSchema = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(['BUNDLED', 'SELF_HOSTED', 'CLOUD']),
  routingMode: z.enum(['DISABLED', 'LEGACY', 'EXPLICIT']),
  enabled: z.boolean(),
  uiBaseUrl: OptionalUrl,
  callbackBaseUrl: OptionalUrl,
  webhookBaseUrl: OptionalUrl,
  hmacSecret: z.string().max(1_000),
  apiBaseUrl: OptionalUrl,
  apiKey: z.string().max(2_000),
  keepHmac: z.boolean(),
  keepApiKey: z.boolean(),
});

const EventName = z.string().min(1).max(80).refine(isAllowedN8nEvent, 'Unbekanntes Event.');
const EndpointSchema = z
  .object({
    id: z.union([z.literal(''), z.string().uuid()]),
    name: z.string().trim().min(1).max(120),
    productionUrl: ProductionWebhookUrl,
    testUrl: z.union([z.literal(''), TestWebhookUrl]),
    workflowId: z.string().trim().max(200),
    workflowName: z.string().trim().max(200),
    workflowNodeId: z.string().trim().max(200),
    source: z.enum(['MANAGED', 'DISCOVERED', 'CUSTOM']).default('CUSTOM'),
    enabled: z.boolean(),
    events: z.array(EventName).min(1, 'Mindestens ein Event auswählen.'),
  })
  .superRefine((data, ctx) => {
    if (!data.testUrl && requiresSeparateTestWebhook(data.events)) {
      ctx.addIssue({
        code: 'custom',
        path: ['testUrl'],
        message:
          'Für Fach-Events ist die getrennte n8n-Test-URL erforderlich; Produktionstests sind nur für taxtronik.ping erlaubt.',
      });
    }
  });

function parseConnectionForm(formData: FormData) {
  return ConnectionSchema.safeParse({
    name: formData.get('name') ?? 'TaxTronik n8n',
    kind: formData.get('kind') ?? 'SELF_HOSTED',
    routingMode: formData.get('routingMode') ?? 'EXPLICIT',
    enabled: formData.get('enabled') === 'on',
    uiBaseUrl: formData.get('uiBaseUrl') ?? '',
    callbackBaseUrl: formData.get('callbackBaseUrl') ?? '',
    webhookBaseUrl: formData.get('webhookBaseUrl') ?? '',
    hmacSecret: formData.get('hmacSecret') ?? '',
    apiBaseUrl: formData.get('apiBaseUrl') ?? '',
    apiKey: formData.get('apiKey') ?? '',
    keepHmac: formData.get('keepHmac') === 'on',
    keepApiKey: formData.get('keepApiKey') === 'on',
  });
}

function parseEndpointForm(formData: FormData) {
  return EndpointSchema.safeParse({
    id: formData.get('id') ?? '',
    name: formData.get('name') ?? '',
    productionUrl: formData.get('productionUrl') ?? '',
    testUrl: formData.get('testUrl') ?? '',
    workflowId: formData.get('workflowId') ?? '',
    workflowName: formData.get('workflowName') ?? '',
    workflowNodeId: formData.get('workflowNodeId') ?? '',
    source: formData.get('source') ?? 'CUSTOM',
    enabled: formData.get('enabled') === 'on',
    events: formData.getAll('events'),
  });
}

async function requireAdmin() {
  const guard = await staffActionGuard({ requireAdmin: true });
  if (!guard.ok) return { ok: false as const, error: guard.error };
  return { ok: true as const, tenantId: guard.tenantId, staffId: guard.staffId };
}

function context(auth: { tenantId: string; staffId: string }) {
  return { tenantId: auth.tenantId, actorId: auth.staffId, actorType: 'STAFF' as const };
}

function revalidateN8n() {
  revalidatePath('/staff/admin/settings/n8n');
  revalidatePath('/staff/admin/settings/integrations');
}

async function recordEvidence(
  ctx: ReturnType<typeof context>,
  action: string,
  resourceId: string,
  after: Record<string, unknown> | null,
  resourceType = 'n8n_connection',
) {
  await withTenantContext(ctx, (tx) =>
    evidenceService.record(tx, {
      tenantId: ctx.tenantId,
      actorType: 'STAFF',
      actorId: ctx.actorId,
      action,
      resourceType,
      resourceId,
      after,
    }),
  );
}

async function validateStoredUrl(url: string): Promise<void> {
  if (url) await assertPublicHost(url);
}

function sameUrlOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

export async function saveN8nAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };
  const parsed = parseConnectionForm(formData);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Ungültige Eingabe.' };

  const ctx = context(auth);
  const previous = await resolveN8nConfig(ctx);
  const data = parsed.data;
  const hmacSecret = data.keepHmac ? previous.hmacSecret : data.hmacSecret;
  const apiKey = data.keepApiKey ? previous.apiKey : data.apiKey;
  const callbackBaseUrl = data.callbackBaseUrl.trim() || defaultN8nCallbackBase(data.kind);

  if (hmacSecret && hmacSecret.length < 32) {
    return { ok: false, error: 'Das Signatur-Secret muss mindestens 32 Zeichen lang sein.' };
  }
  if (Boolean(data.apiBaseUrl) !== Boolean(apiKey)) {
    return { ok: false, error: 'n8n-API-URL und API-Key müssen gemeinsam gesetzt werden.' };
  }
  // Instanzwechsel-Guard nur bei tatsächlich gespeicherter Vorgänger-URL:
  // sameUrlOrigin('') ist false, eine leere/genullte Alt-URL blockierte sonst
  // jede Neueingabe dauerhaft ("Bei Wechsel ... neu eingegeben werden").
  if (
    data.keepApiKey &&
    previous.apiKey &&
    previous.apiBaseUrl &&
    !sameUrlOrigin(data.apiBaseUrl, previous.apiBaseUrl)
  ) {
    return {
      ok: false,
      error:
        'Die Public-API-Adresse zeigt auf eine andere n8n-Instanz. Bitte den API-Key dieser Instanz eingeben — der gespeicherte Key wird nicht an einen fremden Host gesendet.',
    };
  }
  if (data.routingMode === 'LEGACY' && (!data.webhookBaseUrl || !hmacSecret)) {
    return { ok: false, error: 'Der Legacy-Modus benötigt Webhook-Präfix und Signatur-Secret.' };
  }

  try {
    await Promise.all([validateStoredUrl(data.webhookBaseUrl), validateStoredUrl(data.apiBaseUrl)]);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }

  const cfg: N8nConfig = {
    ...previous,
    name: data.name,
    kind: data.kind,
    routingMode: data.routingMode,
    enabled: data.routingMode !== 'DISABLED' && data.enabled,
    uiBaseUrl: data.uiBaseUrl.trim().replace(/\/$/, ''),
    callbackBaseUrl: callbackBaseUrl.replace(/\/$/, ''),
    webhookBaseUrl: data.webhookBaseUrl.trim().replace(/\/$/, ''),
    hmacSecret,
    apiBaseUrl: data.apiBaseUrl.trim().replace(/\/$/, ''),
    apiKey,
    source: 'CONNECTION',
  };

  const signingSecretChanged = previous.hmacSecret !== cfg.hmacSecret;
  const deliveryConfigurationChanged =
    signingSecretChanged ||
    previous.connectionId === null ||
    previous.enabled !== cfg.enabled ||
    previous.routingMode !== cfg.routingMode ||
    (previous.webhookBaseUrl !== cfg.webhookBaseUrl &&
      (previous.routingMode === 'LEGACY' || cfg.routingMode === 'LEGACY'));
  const cancelledPendingDeliveries = await withTenantContext(ctx, async (tx) => {
    const connectionId = await writeN8nConfigTx(tx, ctx, cfg);
    const cancelled = deliveryConfigurationChanged
      ? await cancelPendingN8nDeliveries(tx, {
          tenantId: ctx.tenantId,
          reason: 'n8n-Verbindungs- oder Signaturkonfiguration wurde geändert',
        })
      : { deliveryCount: 0, outboxIds: [] };
    if (signingSecretChanged) {
      await tx.n8nWebhookEndpoint.updateMany({
        where: { tenantId: ctx.tenantId },
        data: {
          enabled: false,
          verifiedAt: null,
          verificationOk: null,
          verificationError: 'Signatur-Secret geändert; Route muss erneut getestet werden.',
        },
      });
    }
    await evidenceService.record(tx, {
      tenantId: ctx.tenantId,
      actorType: 'STAFF',
      actorId: ctx.actorId,
      action: 'tenant.settings.n8n.update',
      resourceType: 'n8n_connection',
      resourceId: connectionId,
      after: {
        name: cfg.name,
        kind: cfg.kind,
        routingMode: cfg.routingMode,
        enabled: cfg.enabled,
        uiBaseUrl: cfg.uiBaseUrl || null,
        callbackBaseUrl: cfg.callbackBaseUrl,
        webhookBaseUrl: cfg.webhookBaseUrl || null,
        apiBaseUrl: cfg.apiBaseUrl || null,
        signingSecret: cfg.hmacSecret ? '***' : null,
        apiKey: cfg.apiKey ? '***' : null,
        signingSecretChanged,
        cancelledPendingDeliveries: cancelled.deliveryCount,
      },
    });
    return cancelled.deliveryCount;
  });
  revalidateN8n();
  return {
    ok: true,
    message: signingSecretChanged
      ? `Verbindung gespeichert; Routen müssen wegen des neuen Signatur-Secrets erneut getestet werden (${cancelledPendingDeliveries} wartende Zustellungen abgebrochen).`
      : 'Verbindung gespeichert.',
  };
}

export async function resetN8nAction(): Promise<ActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };
  const ctx = context(auth);
  const reset = await withTenantContext(ctx, async (tx) => {
    const current = await tx.n8nConnection.findUnique({
      where: { tenantId: ctx.tenantId },
      select: { id: true },
    });
    const cancelled = await cancelPendingN8nDeliveries(tx, {
      tenantId: ctx.tenantId,
      reason: 'n8n-Integration wurde deaktiviert und zurückgesetzt',
    });
    await tx.n8nWebhookEndpoint.deleteMany({ where: { tenantId: ctx.tenantId } });
    const connection = await tx.n8nConnection.upsert({
      where: { tenantId: ctx.tenantId },
      create: {
        tenantId: ctx.tenantId,
        name: 'TaxTronik n8n',
        kind: 'BUNDLED',
        routingMode: 'DISABLED',
        enabled: false,
      },
      update: {
        name: 'TaxTronik n8n',
        routingMode: 'DISABLED',
        enabled: false,
        uiBaseUrl: null,
        apiBaseUrl: null,
        webhookBaseUrl: null,
        callbackBaseUrl: null,
        apiKeyEncrypted: null,
        signingSecretEncrypted: null,
        callbackTokenHash: null,
        callbackScopes: [],
        healthCheckedAt: null,
        healthOk: null,
        healthError: null,
      },
      select: { id: true },
    });
    await tx.tenantSetting.deleteMany({
      where: { tenantId: ctx.tenantId, key: 'integrations.n8n' },
    });
    await evidenceService.record(tx, {
      tenantId: ctx.tenantId,
      actorType: 'STAFF',
      actorId: ctx.actorId,
      action: 'tenant.settings.n8n.delete',
      resourceType: 'n8n_connection',
      resourceId: current?.id ?? connection.id,
      after: {
        disabled: true,
        routesRemoved: true,
        credentialsRemoved: true,
        cancelledPendingDeliveries: cancelled.deliveryCount,
      },
    });
    return cancelled.deliveryCount;
  });
  revalidateN8n();
  return {
    ok: true,
    message: `Integration deaktiviert; Credentials und Routen entfernt (${reset} wartende Zustellungen abgebrochen).`,
  };
}

export async function generateSigningSecretAction(): Promise<ActionResult & { secret?: string }> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };
  return { ok: true, secret: randomBytes(32).toString('base64url') };
}

export async function testN8nApiAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };
  const parsed = parseConnectionForm(formData);
  if (!parsed.success) return { ok: false, error: 'Ungültige Eingabe.' };

  const ctx = context(auth);
  const previous = await resolveN8nConfig(ctx);
  if (
    parsed.data.keepApiKey &&
    previous.apiKey &&
    previous.apiBaseUrl &&
    !sameUrlOrigin(parsed.data.apiBaseUrl, previous.apiBaseUrl)
  ) {
    return {
      ok: false,
      error:
        'Der gespeicherte API-Key wird nicht an eine andere n8n-Instanz gesendet. Bitte den API-Key der neuen Instanz eingeben und erneut testen.',
    };
  }
  const apiKey = parsed.data.keepApiKey ? previous.apiKey : parsed.data.apiKey;
  const apiBaseUrl = parsed.data.apiBaseUrl.trim();
  const testingStoredConfig = Boolean(
    previous.connectionId &&
    parsed.data.keepApiKey &&
    apiBaseUrl.replace(/\/$/, '') === previous.apiBaseUrl.replace(/\/$/, ''),
  );
  try {
    await validateStoredUrl(apiBaseUrl);
    const result = await new N8nApiClient(apiBaseUrl, apiKey).ping();
    if (previous.connectionId && testingStoredConfig) {
      await withTenantContext(ctx, (tx) =>
        tx.n8nConnection.updateMany({
          where: { id: previous.connectionId!, tenantId: ctx.tenantId },
          data: { healthCheckedAt: new Date(), healthOk: true, healthError: null },
        }),
      );
    }
    revalidateN8n();
    return {
      ok: true,
      message: `API erreichbar (${result.latencyMs} ms, authentifiziert).`,
    };
  } catch (error) {
    if (previous.connectionId && testingStoredConfig) {
      await withTenantContext(ctx, (tx) =>
        tx.n8nConnection.updateMany({
          where: { id: previous.connectionId!, tenantId: ctx.tenantId },
          data: {
            healthCheckedAt: new Date(),
            healthOk: false,
            healthError: (error as Error).message.slice(0, 500),
          },
        }),
      );
    }
    revalidateN8n();
    return { ok: false, error: (error as Error).message };
  }
}

export interface CallbackCredentialResult extends ActionResult {
  credential?: {
    keyId: string;
    token: string;
    baseUrl: string;
    scopes: string[];
  };
}

/** Rotiert das Callback-Token. Der Klartext wird genau in dieser Antwort ausgegeben. */
export async function rotateN8nCallbackCredentialAction(
  requestedScopes: string[],
): Promise<CallbackCredentialResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };
  const scopesResult = z
    .array(z.enum(N8N_CALLBACK_SCOPES))
    .max(N8N_CALLBACK_SCOPES.length)
    .safeParse([...new Set(requestedScopes)]);
  if (!scopesResult.success) return { ok: false, error: 'Ungültige Callback-Berechtigungen.' };
  const ctx = context(auth);
  let rotated: Awaited<ReturnType<typeof rotateN8nCallbackCredential>>;
  try {
    rotated = await rotateN8nCallbackCredential(ctx, scopesResult.data);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return {
      ok: false,
      error:
        code === 'P2025'
          ? 'Bitte zuerst die n8n-Verbindung speichern.'
          : 'Callback-Zugang konnte nicht atomar rotiert werden.',
    };
  }

  const { token, connection } = rotated;
  revalidateN8n();
  return {
    ok: true,
    message: 'Callback-Zugang neu erzeugt. Das Token wird nur jetzt angezeigt.',
    credential: {
      keyId: connection.callbackKeyId,
      token,
      baseUrl: `${(connection.callbackBaseUrl || defaultN8nCallbackBase(connection.kind)).replace(
        /\/$/,
        '',
      )}/api/integrations/n8n/v1`,
      scopes: connection.callbackScopes,
    },
  };
}

export async function saveN8nEndpointAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };
  const parsed = parseEndpointForm(formData);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Ungültige Route.' };
  const data = parsed.data;
  const ctx = context(auth);

  try {
    await Promise.all([
      validateStoredUrl(data.productionUrl),
      data.testUrl ? validateStoredUrl(data.testUrl) : Promise.resolve(),
    ]);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }

  try {
    const endpoint = await withTenantContext(ctx, async (tx) => {
      const connection = await tx.n8nConnection.findUnique({ where: { tenantId: ctx.tenantId } });
      if (!connection) throw new Error('Bitte zuerst die n8n-Verbindung speichern.');

      let endpointId = data.id;
      let activationBlocked: boolean;
      let cancelledPendingDeliveries = 0;
      if (endpointId) {
        const exists = await tx.n8nWebhookEndpoint.findFirst({
          where: { id: endpointId, tenantId: ctx.tenantId, connectionId: connection.id },
          select: {
            id: true,
            productionUrl: true,
            testUrl: true,
            enabled: true,
            updatedAt: true,
            verificationOk: true,
            subscriptions: { select: { event: true } },
          },
        });
        if (!exists) throw new Error('Webhook-Route nicht gefunden.');
        const previousEvents = exists.subscriptions
          .map((item) => item.event)
          .sort()
          .join('\n');
        const nextEvents = [...new Set(data.events)].sort().join('\n');
        const routeChanged =
          exists.productionUrl !== data.productionUrl ||
          (exists.testUrl ?? '') !== data.testUrl ||
          previousEvents !== nextEvents;
        const mayActivate = !routeChanged && exists.verificationOk === true;
        activationBlocked = data.enabled && !mayActivate;
        if (routeChanged || (exists.enabled && !data.enabled)) {
          const cancelled = await cancelPendingN8nDeliveries(tx, {
            tenantId: ctx.tenantId,
            endpointId,
            reason: routeChanged
              ? 'n8n-Route oder Event-Zuordnung wurde geändert'
              : 'n8n-Route wurde deaktiviert',
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
            enabled: data.enabled && mayActivate,
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
          throw new Error(
            'Die Route wurde parallel geändert. Bitte aktuellen Stand laden und erneut speichern.',
          );
        }
      } else {
        activationBlocked = data.enabled;
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
            enabled: false,
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
      await tx.n8nConnection.update({
        where: { id: connection.id },
        // Eine Route darf eine bewusst deaktivierte Connection nicht nebenbei
        // reaktivieren. Nur eine bereits aktive Legacy-Connection wechselt beim
        // ersten expliziten Mapping in den neuen Routingmodus.
        data:
          connection.enabled && connection.routingMode !== 'DISABLED'
            ? { routingMode: 'EXPLICIT' }
            : {},
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
          enabled: data.enabled && !activationBlocked,
          events: data.events,
          cancelledPendingDeliveries,
        },
      });
      return { id: endpointId, connectionId: connection.id, activationBlocked };
    });
    revalidateN8n();
    return {
      ok: true,
      message: endpoint.activationBlocked
        ? 'Route als Entwurf gespeichert. Bitte zuerst testen und danach aktivieren.'
        : 'Workflow-Route gespeichert.',
    };
  } catch (error) {
    const message = (error as Error).message;
    return {
      ok: false,
      error: message.includes('Unique constraint')
        ? 'Eine Route mit diesem Namen existiert bereits.'
        : message,
    };
  }
}

export async function deleteN8nEndpointAction(endpointId: string): Promise<ActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };
  const parsed = z.string().uuid().safeParse(endpointId);
  if (!parsed.success) return { ok: false, error: 'Ungültige Route.' };
  const ctx = context(auth);
  const deleted = await withTenantContext(ctx, async (tx) => {
    const cancelled = await cancelPendingN8nDeliveries(tx, {
      tenantId: ctx.tenantId,
      endpointId: parsed.data,
      reason: 'n8n-Route wurde entfernt',
    });
    const result = await tx.n8nWebhookEndpoint.deleteMany({
      where: { id: parsed.data, tenantId: ctx.tenantId },
    });
    if (result.count) {
      await evidenceService.record(tx, {
        tenantId: ctx.tenantId,
        actorType: 'STAFF',
        actorId: ctx.actorId,
        action: 'tenant.settings.n8n.endpoint.delete',
        resourceType: 'n8n_webhook_endpoint',
        resourceId: parsed.data,
        after: { cancelledPendingDeliveries: cancelled.deliveryCount },
      });
    }
    return result;
  });
  if (!deleted.count) return { ok: false, error: 'Route nicht gefunden.' };
  revalidateN8n();
  return { ok: true, message: 'Route entfernt.' };
}

/** Lädt offene Fehler unabhängig von neueren erfolgreichen Zustellungen seitenweise nach. */
export async function listFailedN8nDeliveriesAction(
  cursor?: string,
): Promise<N8nFailedDeliveryPageResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };
  const parsedCursor = cursor ? z.string().uuid().safeParse(cursor) : null;
  if (parsedCursor && !parsedCursor.success) {
    return { ok: false, error: 'Ungültiger Seitenzeiger.' };
  }
  const ctx = context(auth);
  const rows = await withTenantContext(ctx, (tx) =>
    tx.n8nDelivery.findMany({
      where: { tenantId: ctx.tenantId, status: 'FAILED' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(parsedCursor?.success ? { cursor: { id: parsedCursor.data }, skip: 1 } : {}),
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
export async function acknowledgeN8nDeliveryAction(deliveryId: string): Promise<ActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };
  const parsed = z.string().uuid().safeParse(deliveryId);
  if (!parsed.success) return { ok: false, error: 'Ungültige Zustellung.' };
  const ctx = context(auth);

  const acknowledged = await withTenantContext(ctx, async (tx) => {
    const delivery = await acknowledgeFailedN8nDelivery(tx, {
      tenantId: ctx.tenantId,
      deliveryId: parsed.data,
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
  revalidateN8n();
  return { ok: true, message: 'Fehler wurde revisionsprotokolliert quittiert.' };
}

export async function retryN8nDeliveryAction(deliveryId: string): Promise<ActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };
  const parsed = z.string().uuid().safeParse(deliveryId);
  if (!parsed.success) return { ok: false, error: 'Ungültige Zustellung.' };
  const ctx = context(auth);

  const reset = await withTenantContext(ctx, async (tx) => {
    const delivery = await tx.n8nDelivery.findFirst({
      where: { id: parsed.data, tenantId: ctx.tenantId, status: 'FAILED' },
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
            subscriptions: {
              where: { enabled: true },
              select: { event: true },
            },
          },
        },
      },
    });
    if (!delivery) return { kind: 'missing' as const };
    const connection = await tx.n8nConnection.findUnique({
      where: { tenantId: ctx.tenantId },
      select: { id: true, enabled: true, routingMode: true, signingSecretEncrypted: true },
    });
    const currentTarget =
      n8nDeliveryMode === 'test' ? delivery.endpoint?.testUrl : delivery.endpoint?.productionUrl;
    const routeIsCurrent = Boolean(
      delivery.endpoint?.enabled &&
      delivery.endpoint.connectionId === connection?.id &&
      delivery.connectionIdSnapshot === connection?.id &&
      connection.enabled &&
      connection.routingMode === 'EXPLICIT' &&
      connection.signingSecretEncrypted &&
      currentTarget &&
      currentTarget === delivery.targetUrl &&
      delivery.endpoint.subscriptions.some(
        (subscription) => subscription.event === delivery.outbox.event,
      ),
    );
    if (!routeIsCurrent) return { kind: 'stale' as const };
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
  });
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
    await getN8nDeliverQueue().add(
      'deliver',
      { deliveryId: reset.id },
      {
        jobId: `manual-retry-${reset.id}-${randomUUID()}`,
        attempts: 6,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: { age: 24 * 60 * 60 },
        removeOnFail: { age: 7 * 24 * 60 * 60 },
      },
    );
  } catch (error) {
    await withTenantContext(ctx, async (tx) => {
      await tx.n8nDelivery.updateMany({
        where: { id: reset.id, tenantId: ctx.tenantId, status: 'PENDING' },
        data: {
          status: 'FAILED',
          lastError: `Retry konnte nicht eingeplant werden: ${(error as Error).message}`.slice(
            0,
            1_000,
          ),
        },
      });
      await aggregateN8nOutbox(tx, reset.outboxId);
    });
    revalidateN8n();
    return { ok: false, error: 'Retry konnte nicht in die Queue eingereiht werden.' };
  }

  revalidateN8n();
  return { ok: true, message: 'Zustellung wurde erneut eingeplant.' };
}

/** Ordnet ein historisches UNROUTED-Event bewusst den jetzt aktiven Routen zu. */
export async function replayUnroutedN8nEventAction(outboxId: string): Promise<ActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };
  const parsed = z.string().uuid().safeParse(outboxId);
  if (!parsed.success) return { ok: false, error: 'Ungültiges Event.' };
  const ctx = context(auth);

  const replay = await withTenantContext(ctx, async (tx) => {
    const outbox = await tx.n8nOutbox.findFirst({
      where: { id: parsed.data, tenantId: ctx.tenantId, status: 'UNROUTED' },
      select: { id: true, event: true },
    });
    if (!outbox) return { kind: 'missing' as const };

    const connection = await tx.n8nConnection.findUnique({
      where: { tenantId: ctx.tenantId },
      select: {
        id: true,
        enabled: true,
        routingMode: true,
        signingSecretEncrypted: true,
      },
    });
    if (
      !connection?.enabled ||
      connection.routingMode !== 'EXPLICIT' ||
      !connection.signingSecretEncrypted
    ) {
      return { kind: 'configuration' as const };
    }

    const subscriptions = await tx.n8nEventSubscription.findMany({
      where: {
        tenantId: ctx.tenantId,
        event: outbox.event,
        enabled: true,
        endpoint: { connectionId: connection.id, enabled: true },
      },
      select: {
        endpoint: {
          select: { id: true, name: true, productionUrl: true, testUrl: true },
        },
      },
    });
    if (subscriptions.length === 0) return { kind: 'routes' as const };

    // Claim innerhalb derselben Transaktion: parallele Klicks dürfen nie zwei
    // Delivery-Sätze für dasselbe historische Event erzeugen.
    const claimed = await tx.n8nOutbox.updateMany({
      where: { id: outbox.id, tenantId: ctx.tenantId, status: 'UNROUTED' },
      data: { status: 'PENDING', lastError: null },
    });
    if (!claimed.count) return { kind: 'missing' as const };

    const pendingIds: string[] = [];
    let skipped = 0;
    for (const { endpoint } of subscriptions) {
      const targetUrl = n8nDeliveryMode === 'test' ? endpoint.testUrl : endpoint.productionUrl;
      const skipReason =
        n8nDeliveryMode === 'test' && !targetUrl
          ? 'Kein sicherer n8n-Test-Webhook für diesen Endpoint konfiguriert'
          : null;
      const delivery = await tx.n8nDelivery.create({
        data: {
          tenantId: ctx.tenantId,
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
      if (skipReason) skipped += 1;
      else pendingIds.push(delivery.id);
    }

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
        deliveriesCreated: subscriptions.length,
        skipped,
      },
    });
    return { kind: 'replayed' as const, pendingIds, total: subscriptions.length, skipped };
  });

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
      await getN8nDeliverQueue().add(
        'deliver',
        { deliveryId },
        {
          jobId: `delivery-${deliveryId}`,
          attempts: 6,
          backoff: { type: 'exponential', delay: 60_000 },
          removeOnComplete: { age: 24 * 60 * 60 },
          removeOnFail: { age: 7 * 24 * 60 * 60 },
        },
      );
    } catch {
      // Der Reconcile-Job nimmt persistierte PENDING-Deliveries wieder auf.
      queueFailures += 1;
    }
  }
  revalidateN8n();
  return {
    ok: true,
    message:
      queueFailures > 0
        ? `${replay.total} Ziel(e) zugeordnet; ${queueFailures} warten auf automatische Queue-Reconciliation.`
        : `${replay.total} Ziel(e) zugeordnet${replay.skipped ? `, ${replay.skipped} übersprungen` : ''}.`,
  };
}

/** Schließt ein UNROUTED-Event nach bewusster Admin-Entscheidung ohne Versand ab. */
export async function skipUnroutedN8nEventAction(outboxId: string): Promise<ActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };
  const parsed = z.string().uuid().safeParse(outboxId);
  if (!parsed.success) return { ok: false, error: 'Ungültiges Event.' };
  const ctx = context(auth);

  const skipped = await withTenantContext(ctx, async (tx) => {
    const outbox = await tx.n8nOutbox.findFirst({
      where: { id: parsed.data, tenantId: ctx.tenantId, status: 'UNROUTED' },
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
  revalidateN8n();
  return { ok: true, message: 'Event wurde nachvollziehbar ohne Versand abgeschlossen.' };
}

function joinWebhookUrl(prefix: string, path: string): string {
  return `${prefix.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

function testWebhookPrefix(productionPrefix: string): string {
  return /\/webhook\/?$/i.test(productionPrefix)
    ? productionPrefix.replace(/\/webhook\/?$/i, '/webhook-test')
    : '';
}

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

export async function discoverN8nWebhooksAction(): Promise<
  ActionResult & { webhooks?: N8nDiscoveredWebhookView[] }
> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };
  const cfg = await readN8nConfig(context(auth));
  if (!cfg?.apiBaseUrl || !cfg.apiKey)
    return { ok: false, error: 'n8n-API ist nicht konfiguriert.' };

  try {
    const discovered = await new N8nApiClient(cfg.apiBaseUrl, cfg.apiKey).discoverWebhooks();
    const productionPrefix = cfg.webhookBaseUrl;
    const testPrefix = productionPrefix ? testWebhookPrefix(productionPrefix) : '';
    return {
      ok: true,
      message: `${discovered.length} Webhook-Knoten gefunden.`,
      webhooks: discovered
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
        })),
    };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

export async function testN8nEndpointAction(
  endpointId: string,
  useTestUrl = false,
  requestedEvent = 'taxtronik.ping',
): Promise<ActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!z.string().uuid().safeParse(endpointId).success)
    return { ok: false, error: 'Ungültige Route.' };
  if (!isAllowedN8nEvent(requestedEvent)) return { ok: false, error: 'Unbekanntes Test-Event.' };
  if (!useTestUrl && requestedEvent !== 'taxtronik.ping') {
    return {
      ok: false,
      error: 'Synthetische Fach-Events dürfen nur an die separate n8n-Test-URL gesendet werden.',
    };
  }
  const ctx = context(auth);
  const cfg = await readN8nConfig(ctx);
  if (!cfg?.hmacSecret) return { ok: false, error: 'Signatur-Secret fehlt.' };

  const endpoint = await withTenantContext(ctx, (tx) =>
    tx.n8nWebhookEndpoint.findFirst({
      where: {
        id: endpointId,
        tenantId: ctx.tenantId,
        subscriptions: { some: { event: requestedEvent, enabled: true } },
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
  const catalogEntry = N8N_EVENT_CATALOG.find((entry) => entry.name === requestedEvent);
  const body = JSON.stringify({
    schemaVersion: 1,
    eventId,
    deliveryId,
    event: requestedEvent,
    tenantId: ctx.tenantId,
    occurredAt: new Date().toISOString(),
    payload: {
      ...(catalogEntry?.examplePayload ?? { from: 'taxtronik-settings-ui' }),
      synthetic: true,
    },
  });
  const signature = signOutboundN8n(requestedEvent, body, cfg.hmacSecret);
  const started = Date.now();
  try {
    const response = await safeFetch(targetUrl, {
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
    let challengeOk = true;
    if (requestedEvent === 'taxtronik.ping') {
      try {
        const parsedResponse = JSON.parse(responseBody) as { challenge?: unknown; event?: unknown };
        challengeOk =
          parsedResponse.challenge === 'taxtronik-connection-ok' &&
          parsedResponse.event === 'taxtronik.ping';
      } catch {
        challengeOk = false;
      }
    }
    const ok = response.ok && challengeOk;
    const verificationError = !response.ok
      ? `HTTP ${response.status}: ${responseBody || 'leere Antwort'}`
      : !challengeOk
        ? 'Antwort enthält nicht die erwartete TaxTronik-Challenge.'
        : null;
    const verificationRecorded = await withTenantContext(ctx, async (tx) => {
      const route = await tx.n8nWebhookEndpoint.updateMany({
        where: { id: endpoint.id, tenantId: ctx.tenantId, updatedAt: endpoint.updatedAt },
        data: {
          verifiedAt: new Date(),
          verificationOk: ok,
          verificationError: verificationError?.slice(0, 500) ?? null,
        },
      });
      if (!route.count) return false;
      await tx.n8nConnection.updateMany({
        where: { id: endpoint.connectionId, tenantId: ctx.tenantId },
        data: {
          healthCheckedAt: new Date(),
          healthOk: ok,
          healthError: verificationError?.slice(0, 500) ?? null,
        },
      });
      return true;
    });
    revalidateN8n();
    if (!verificationRecorded) {
      return {
        ok: false,
        error:
          'Die Route wurde während des Tests geändert. Bitte den aktuellen Stand erneut testen.',
      };
    }
    return ok
      ? { ok: true, message: `Webhook bestätigt (${latency} ms, HTTP ${response.status}).` }
      : { ok: false, error: verificationError ?? 'Webhook-Prüfung fehlgeschlagen.' };
  } catch (error) {
    const message = (error as Error).message;
    const verificationRecorded = await withTenantContext(ctx, async (tx) => {
      const route = await tx.n8nWebhookEndpoint.updateMany({
        where: { id: endpoint.id, tenantId: ctx.tenantId, updatedAt: endpoint.updatedAt },
        data: {
          verifiedAt: new Date(),
          verificationOk: false,
          verificationError: message.slice(0, 500),
        },
      });
      if (!route.count) return false;
      await tx.n8nConnection.updateMany({
        where: { id: endpoint.connectionId, tenantId: ctx.tenantId },
        data: { healthCheckedAt: new Date(), healthOk: false, healthError: message.slice(0, 500) },
      });
      return true;
    });
    revalidateN8n();
    if (!verificationRecorded) {
      return {
        ok: false,
        error:
          'Die Route wurde während des Tests geändert. Bitte den aktuellen Stand erneut testen.',
      };
    }
    return { ok: false, error: message };
  }
}

export interface N8nWorkflowRow {
  id: string;
  name: string;
  active: boolean;
  updatedAt: string;
}

const WorkflowImportSchema = z.object({
  templateIds: z.array(z.string().min(1).max(100)).max(20),
  smtpFrom: z.string().trim().max(320).default(''),
  gwgOfficerEmail: z.union([z.literal(''), z.string().email().max(320)]).default(''),
});

export async function listWorkflowsAction(): Promise<
  ActionResult & { workflows?: N8nWorkflowRow[] }
> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };
  const cfg = await readN8nConfig(context(auth));
  if (!cfg?.apiBaseUrl || !cfg.apiKey)
    return { ok: false, error: 'n8n-API ist nicht konfiguriert.' };
  try {
    const workflows = await new N8nApiClient(cfg.apiBaseUrl, cfg.apiKey).listWorkflows();
    return {
      ok: true,
      workflows: workflows.map(({ id, name, active, updatedAt }) => ({
        id,
        name,
        active,
        updatedAt,
      })),
    };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/** Importiert nur fehlende Vorlagen. Aktivierung und Credentials bleiben in n8n. */
export async function importWorkflowsAction(
  input: {
    templateIds: string[];
    smtpFrom?: string;
    gwgOfficerEmail?: string;
  } = { templateIds: BUNDLED_N8N_WORKFLOWS.map((template) => template.templateId) },
): Promise<ActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };
  const ctx = context(auth);
  const cfg = await readN8nConfig(ctx);
  if (!cfg?.apiBaseUrl || !cfg.apiKey)
    return { ok: false, error: 'n8n-API ist nicht konfiguriert.' };
  const parsed = WorkflowImportSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Ungültige Importwerte.' };
  }
  const knownIds = new Set(BUNDLED_N8N_WORKFLOWS.map((template) => template.templateId));
  if (parsed.data.templateIds.some((id) => !knownIds.has(id))) {
    return { ok: false, error: 'Unbekannte Workflow-Vorlage ausgewählt.' };
  }
  if (parsed.data.templateIds.length === 0) {
    return { ok: false, error: 'Bitte mindestens eine Workflow-Vorlage auswählen.' };
  }

  try {
    const client = new N8nApiClient(cfg.apiBaseUrl, cfg.apiKey);
    const existing = await client.listWorkflows();
    const existingNames = new Set(existing.map((item) => item.name));
    const smtp = await readSmtpConfig(ctx);
    const smtpFrom = parsed.data.smtpFrom || smtp?.from || env.SMTP_FROM || '';
    const importValues = {
      taxtronikApiUrl: cfg.callbackBaseUrl || defaultN8nCallbackBase(cfg.kind),
      callbackKeyId: cfg.callbackKeyId,
      smtpFrom,
      gwgOfficerEmail: parsed.data.gwgOfficerEmail,
    };
    const imported: string[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];

    for (const template of BUNDLED_N8N_WORKFLOWS.filter((candidate) =>
      parsed.data.templateIds.includes(candidate.templateId),
    )) {
      const workflowName =
        typeof template.workflow['name'] === 'string' ? template.workflow['name'] : template.name;
      if (existingNames.has(workflowName)) {
        skipped.push(workflowName);
        continue;
      }
      try {
        if (
          ['taxtronik.request-reminder', 'taxtronik.gwg-expiry-check'].includes(
            template.templateId,
          ) &&
          !smtpFrom
        ) {
          throw new Error('Mail-Absender für n8n fehlt');
        }
        if (template.templateId === 'taxtronik.gwg-expiry-check' && !parsed.data.gwgOfficerEmail) {
          throw new Error('E-Mail der GwG-verantwortlichen Person fehlt');
        }
        const missingScopes = template.callbackScopes.filter(
          (scope) => !cfg.callbackScopes.includes(scope),
        );
        if (template.callbackScopes.length && !cfg.callbackConfigured) {
          throw new Error('Callback-Token fehlt');
        }
        if (missingScopes.length) {
          throw new Error(`Callback-Berechtigung fehlt: ${missingScopes.join(', ')}`);
        }
        const materialized = materializeBundledN8nWorkflow(template.workflow, importValues);
        const unresolved = unresolvedBundledN8nPlaceholders(materialized);
        if (unresolved.length) {
          throw new Error(`Einrichtungswert fehlt: ${unresolved.join(', ')}`);
        }
        await client.createWorkflow(materialized);
        imported.push(workflowName);
        existingNames.add(workflowName);
      } catch (error) {
        errors.push(`${workflowName}: ${(error as Error).message}`);
      }
    }

    const connectionId = cfg.connectionId ?? 'integrations.n8n';
    await recordEvidence(ctx, 'tenant.settings.n8n.workflows_import', connectionId, {
      imported,
      skipped,
      errors,
      autoActivated: false,
    });
    revalidateN8n();
    const summary = [
      imported.length ? `${imported.length} importiert` : '',
      skipped.length ? `${skipped.length} vorhanden` : '',
      errors.length ? `${errors.length} Fehler` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    return {
      ok: errors.length === 0,
      message: `${summary || 'Nichts zu tun.'} Workflows wurden nicht automatisch aktiviert.`,
      error: errors.length ? errors.join('\n') : undefined,
    };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
