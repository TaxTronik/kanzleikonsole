'use server';

// =============================================================================
// n8n-Administration: Server-Actions (Admin-Gate → Parsen → Service).
//
// Die Abläufe liegen seit K-03 unter server/n8n-settings: Verbindung
// (connection.ts), API-Test (api-test.ts), Routen (endpoints.ts),
// Zustellungen (deliveries.ts), Vorlagen-Import (workflows.ts) und die reinen
// Prüf-/Normalisierungsregeln (validation.ts). Namen, Argumente und
// Ergebnisformen der Actions sind unverändert (n8n-form.tsx & Co.).
// =============================================================================

import { z } from 'zod';
import { isAllowedN8nEvent } from '@taxtronik/n8n-shared';
import { staffActionGuard } from '@/server/actions/staff-action';
import { BUNDLED_N8N_WORKFLOWS } from '@/server/n8n/bundled-workflows';
import type { N8nRecentDeliveryView } from '@/server/n8n/status';
import { N8N_CALLBACK_SCOPES } from '@/server/settings/n8n';
import { testN8nApi } from '@/server/n8n-settings/api-test';
import {
  generateN8nSigningSecret,
  resetN8nConnection,
  rotateN8nCallbackAccess,
  saveN8nConnection,
} from '@/server/n8n-settings/connection';
import {
  acknowledgeN8nDelivery,
  listFailedN8nDeliveries,
  replayUnroutedN8nEvent,
  retryN8nDelivery,
  skipUnroutedN8nEvent,
} from '@/server/n8n-settings/deliveries';
import {
  deleteN8nEndpoint,
  discoverN8nWebhooks,
  saveN8nEndpoint,
  testN8nEndpoint,
  type N8nDiscoveredWebhookView,
} from '@/server/n8n-settings/endpoints';
import { ConnectionSchema, EndpointSchema } from '@/server/n8n-settings/validation';
import {
  importN8nWorkflows,
  listN8nWorkflows,
  type N8nWorkflowRow,
} from '@/server/n8n-settings/workflows';

export type { N8nDiscoveredWebhookView, N8nWorkflowRow };

export interface ActionResult {
  ok: boolean;
  error?: string;
  message?: string;
  connectionActivated?: boolean;
}

export interface N8nFailedDeliveryPageResult extends ActionResult {
  deliveries?: N8nRecentDeliveryView[];
  nextCursor?: string | null;
}

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
    testMode: formData.get('testMode') === 'on',
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

export async function saveN8nAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };
  const parsed = parseConnectionForm(formData);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Ungültige Eingabe.' };
  return saveN8nConnection(context(auth), parsed.data);
}

export async function resetN8nAction(): Promise<ActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };
  return resetN8nConnection(context(auth));
}

export async function generateSigningSecretAction(): Promise<ActionResult & { secret?: string }> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };
  return { ok: true, secret: generateN8nSigningSecret() };
}

export async function testN8nApiAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };
  const parsed = parseConnectionForm(formData);
  if (!parsed.success) return { ok: false, error: 'Ungültige Eingabe.' };
  return testN8nApi(context(auth), parsed.data);
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
  return rotateN8nCallbackAccess(context(auth), scopesResult.data);
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
  return saveN8nEndpoint(context(auth), parsed.data);
}

export async function deleteN8nEndpointAction(endpointId: string): Promise<ActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };
  const parsed = z.string().uuid().safeParse(endpointId);
  if (!parsed.success) return { ok: false, error: 'Ungültige Route.' };
  return deleteN8nEndpoint(context(auth), parsed.data);
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
  return listFailedN8nDeliveries(context(auth), parsedCursor?.success ? parsedCursor.data : null);
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
  return acknowledgeN8nDelivery(context(auth), parsed.data);
}

export async function retryN8nDeliveryAction(deliveryId: string): Promise<ActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };
  const parsed = z.string().uuid().safeParse(deliveryId);
  if (!parsed.success) return { ok: false, error: 'Ungültige Zustellung.' };
  return retryN8nDelivery(context(auth), parsed.data);
}

/** Ordnet ein historisches UNROUTED-Event bewusst den jetzt aktiven Routen zu. */
export async function replayUnroutedN8nEventAction(outboxId: string): Promise<ActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };
  const parsed = z.string().uuid().safeParse(outboxId);
  if (!parsed.success) return { ok: false, error: 'Ungültiges Event.' };
  return replayUnroutedN8nEvent(context(auth), parsed.data);
}

/** Schließt ein UNROUTED-Event nach bewusster Admin-Entscheidung ohne Versand ab. */
export async function skipUnroutedN8nEventAction(outboxId: string): Promise<ActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };
  const parsed = z.string().uuid().safeParse(outboxId);
  if (!parsed.success) return { ok: false, error: 'Ungültiges Event.' };
  return skipUnroutedN8nEvent(context(auth), parsed.data);
}

export async function discoverN8nWebhooksAction(): Promise<
  ActionResult & { webhooks?: N8nDiscoveredWebhookView[] }
> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };
  return discoverN8nWebhooks(context(auth));
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
  return testN8nEndpoint(context(auth), { endpointId, useTestUrl, event: requestedEvent });
}

export async function listWorkflowsAction(): Promise<
  ActionResult & { workflows?: N8nWorkflowRow[] }
> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };
  return listN8nWorkflows(context(auth));
}

export interface WorkflowImportActionResult extends CallbackCredentialResult {
  callbackConfigured?: boolean;
}

/** Importiert nur fehlende Vorlagen. Kein Workflow wird automatisch aktiviert. */
export async function importWorkflowsAction(
  input: {
    templateIds: string[];
    smtpFrom?: string;
    gwgOfficerEmail?: string;
  } = { templateIds: BUNDLED_N8N_WORKFLOWS.map((template) => template.templateId) },
): Promise<WorkflowImportActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };
  return importN8nWorkflows(context(auth), input);
}
