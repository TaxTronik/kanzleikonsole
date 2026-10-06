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
import { staffAction } from '@/server/actions/staff-action';
import { formDefault, formFlag, parseFormData } from '@/server/actions/form-data';
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

/** n8n-Administration nur für ADMIN/PARTNER. */
const N8N_ADMIN = { requireAdmin: true } as const;

/** Akteur der n8n-Services (immer ein Mitarbeiter) aus dem Gate-Kontext. */
function context(auth: { tenantId: string; staffId: string }) {
  return { tenantId: auth.tenantId, actorId: auth.staffId, actorType: 'STAFF' as const };
}

/**
 * Verbindungsformular → ConnectionSchema (R-12): fehlende Felder wie bisher
 * mit Vorgabe (Name, Art, Routing) bzw. '', Schalter nur bei „on“. Die
 * Prüfung selbst bleibt beim Schema des Services.
 */
const ConnectionForm = z
  .object({
    name: formDefault('TaxTronik n8n', z.unknown()),
    kind: formDefault('SELF_HOSTED', z.unknown()),
    routingMode: formDefault('EXPLICIT', z.unknown()),
    enabled: formFlag(),
    uiBaseUrl: formDefault('', z.unknown()),
    callbackBaseUrl: formDefault('', z.unknown()),
    webhookBaseUrl: formDefault('', z.unknown()),
    hmacSecret: formDefault('', z.unknown()),
    apiBaseUrl: formDefault('', z.unknown()),
    apiKey: formDefault('', z.unknown()),
    keepHmac: formFlag(),
    keepApiKey: formFlag(),
  })
  .pipe(ConnectionSchema);

/** Routenformular → EndpointSchema (R-12): wie bisher '' bzw. CUSTOM, Events als Liste. */
const EndpointForm = z
  .object({
    id: formDefault('', z.unknown()),
    name: formDefault('', z.unknown()),
    productionUrl: formDefault('', z.unknown()),
    testUrl: formDefault('', z.unknown()),
    workflowId: formDefault('', z.unknown()),
    workflowName: formDefault('', z.unknown()),
    workflowNodeId: formDefault('', z.unknown()),
    source: formDefault('CUSTOM', z.unknown()),
    enabled: formFlag(),
    testMode: formFlag(),
    events: z.unknown(),
  })
  // Rohwerte wie aus formData.get/getAll — erst EndpointSchema prüft sie.
  .transform((fields) => fields as z.input<typeof EndpointSchema>)
  .pipe(EndpointSchema);

export async function saveN8nAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return staffAction({
    guard: N8N_ADMIN,
    parse: () =>
      parseFormData(ConnectionForm, formData, {
        absentAsNull: true,
        errorMessage: (issues) => issues[0]?.message ?? 'Ungültige Eingabe.',
      }),
    run: (g, data) => saveN8nConnection(context(g), data),
  });
}

export async function resetN8nAction(): Promise<ActionResult> {
  return staffAction({ guard: N8N_ADMIN, run: (g) => resetN8nConnection(context(g)) });
}

export async function generateSigningSecretAction(): Promise<ActionResult & { secret?: string }> {
  return staffAction({
    guard: N8N_ADMIN,
    run: async () => ({ secret: generateN8nSigningSecret() }),
  });
}

export async function testN8nApiAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return staffAction({
    guard: N8N_ADMIN,
    parse: () =>
      parseFormData(ConnectionForm, formData, {
        absentAsNull: true,
        errorMessage: 'Ungültige Eingabe.',
      }),
    run: (g, data) => testN8nApi(context(g), data),
  });
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
  return staffAction({
    guard: N8N_ADMIN,
    run: async (g) => {
      const scopesResult = z
        .array(z.enum(N8N_CALLBACK_SCOPES))
        .max(N8N_CALLBACK_SCOPES.length)
        .safeParse([...new Set(requestedScopes)]);
      if (!scopesResult.success) return { ok: false, error: 'Ungültige Callback-Berechtigungen.' };
      return rotateN8nCallbackAccess(context(g), scopesResult.data);
    },
  });
}

export async function saveN8nEndpointAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return staffAction({
    guard: N8N_ADMIN,
    parse: () =>
      parseFormData(EndpointForm, formData, {
        repeatable: ['events'],
        absentAsNull: true,
        errorMessage: (issues) => issues[0]?.message ?? 'Ungültige Route.',
      }),
    run: (g, data) => saveN8nEndpoint(context(g), data),
  });
}

export async function deleteN8nEndpointAction(endpointId: string): Promise<ActionResult> {
  return staffAction({
    guard: N8N_ADMIN,
    run: async (g) => {
      const parsed = z.string().uuid().safeParse(endpointId);
      if (!parsed.success) return { ok: false, error: 'Ungültige Route.' };
      return deleteN8nEndpoint(context(g), parsed.data);
    },
  });
}

/** Lädt offene Fehler unabhängig von neueren erfolgreichen Zustellungen seitenweise nach. */
export async function listFailedN8nDeliveriesAction(
  cursor?: string,
): Promise<N8nFailedDeliveryPageResult> {
  return staffAction({
    guard: N8N_ADMIN,
    run: async (g) => {
      const parsedCursor = cursor ? z.string().uuid().safeParse(cursor) : null;
      if (parsedCursor && !parsedCursor.success) {
        return { ok: false, error: 'Ungültiger Seitenzeiger.' };
      }
      return listFailedN8nDeliveries(context(g), parsedCursor?.success ? parsedCursor.data : null);
    },
  });
}

/**
 * Schließt einen bewusst nicht mehr zustellbaren Altfehler administrativ ab.
 * Die Payload bleibt bis zur regulären Retention erhalten; nur der operative
 * Fehlerstatus wechselt revisionsprotokolliert zu SKIPPED.
 */
export async function acknowledgeN8nDeliveryAction(deliveryId: string): Promise<ActionResult> {
  return staffAction({
    guard: N8N_ADMIN,
    run: async (g) => {
      const parsed = z.string().uuid().safeParse(deliveryId);
      if (!parsed.success) return { ok: false, error: 'Ungültige Zustellung.' };
      return acknowledgeN8nDelivery(context(g), parsed.data);
    },
  });
}

export async function retryN8nDeliveryAction(deliveryId: string): Promise<ActionResult> {
  return staffAction({
    guard: N8N_ADMIN,
    run: async (g) => {
      const parsed = z.string().uuid().safeParse(deliveryId);
      if (!parsed.success) return { ok: false, error: 'Ungültige Zustellung.' };
      return retryN8nDelivery(context(g), parsed.data);
    },
  });
}

/** Ordnet ein historisches UNROUTED-Event bewusst den jetzt aktiven Routen zu. */
export async function replayUnroutedN8nEventAction(outboxId: string): Promise<ActionResult> {
  return staffAction({
    guard: N8N_ADMIN,
    run: async (g) => {
      const parsed = z.string().uuid().safeParse(outboxId);
      if (!parsed.success) return { ok: false, error: 'Ungültiges Event.' };
      return replayUnroutedN8nEvent(context(g), parsed.data);
    },
  });
}

/** Schließt ein UNROUTED-Event nach bewusster Admin-Entscheidung ohne Versand ab. */
export async function skipUnroutedN8nEventAction(outboxId: string): Promise<ActionResult> {
  return staffAction({
    guard: N8N_ADMIN,
    run: async (g) => {
      const parsed = z.string().uuid().safeParse(outboxId);
      if (!parsed.success) return { ok: false, error: 'Ungültiges Event.' };
      return skipUnroutedN8nEvent(context(g), parsed.data);
    },
  });
}

export async function discoverN8nWebhooksAction(): Promise<
  ActionResult & { webhooks?: N8nDiscoveredWebhookView[] }
> {
  return staffAction({ guard: N8N_ADMIN, run: (g) => discoverN8nWebhooks(context(g)) });
}

export async function testN8nEndpointAction(
  endpointId: string,
  useTestUrl = false,
  requestedEvent = 'taxtronik.ping',
): Promise<ActionResult> {
  return staffAction({
    guard: N8N_ADMIN,
    run: async (g) => {
      if (!z.string().uuid().safeParse(endpointId).success)
        return { ok: false, error: 'Ungültige Route.' };
      if (!isAllowedN8nEvent(requestedEvent))
        return { ok: false, error: 'Unbekanntes Test-Event.' };
      if (!useTestUrl && requestedEvent !== 'taxtronik.ping') {
        return {
          ok: false,
          error:
            'Synthetische Fach-Events dürfen nur an die separate n8n-Test-URL gesendet werden.',
        };
      }
      return testN8nEndpoint(context(g), { endpointId, useTestUrl, event: requestedEvent });
    },
  });
}

export async function listWorkflowsAction(): Promise<
  ActionResult & { workflows?: N8nWorkflowRow[] }
> {
  return staffAction({ guard: N8N_ADMIN, run: (g) => listN8nWorkflows(context(g)) });
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
  return staffAction({ guard: N8N_ADMIN, run: (g) => importN8nWorkflows(context(g), input) });
}
