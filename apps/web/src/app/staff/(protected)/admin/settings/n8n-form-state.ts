// Reine Zustandslogik des n8n-Adminformulars: je Bereich (Rückkanal,
// Workflows, Routen, Betrieb) ein typisierter Reducer sowie die Payload- und
// Meldungsbausteine der Aktionen. Kein React-Laufzeitcode — die Verdrahtung mit
// Server-Actions, Transition und Router liegt in n8n-form-hooks.ts.

import type { Dispatch, SetStateAction } from 'react';
import type { N8nEventCatalogEntry } from '@taxtronik/n8n-shared';
import type { N8nEndpointView, N8nRecentDeliveryView, N8nSetupStatus } from '@/server/n8n/status';
import { fmtDateTimeShort } from '@/lib/fmt';
import type {
  ActionResult,
  CallbackCredentialResult,
  N8nDiscoveredWebhookView,
  N8nFailedDeliveryPageResult,
  N8nWorkflowRow,
  WorkflowImportActionResult,
} from './n8n-actions';
import type { N8nConnectionAction, N8nConnectionState } from './n8n-connection-state';
import type { BundledWorkflowSummary, N8nBrowserConfig, RouteDraft } from './n8n-form-types';

/** Wendet ein useState-artiges Update (Wert oder Updater-Funktion) an. */
export function applyUpdate<T>(current: T, update: SetStateAction<T>): T {
  return typeof update === 'function' ? (update as (previous: T) => T)(current) : update;
}

/** Setzt ein Feld; unveränderte Werte behalten die Zustandsidentität. */
function withField<S, K extends keyof S>(state: S, key: K, value: S[K]): S {
  return Object.is(state[key], value) ? state : { ...state, [key]: value };
}

function pendingResult(message: string): ActionResult {
  return { ok: true, message };
}

// --- Verbindung -----------------------------------------------------------------

export function isExplicitConnectionActive(
  connection: Pick<N8nConnectionState, 'enabled' | 'routingMode'>,
): boolean {
  return connection.enabled && connection.routingMode === 'EXPLICIT';
}

/** Eine gespeicherte Route kann die Integration serverseitig aktivieren. */
export function syncConnectionActivation(
  dispatch: Dispatch<N8nConnectionAction>,
  result: ActionResult,
): void {
  if (!result.connectionActivated) return;
  dispatch({
    type: 'patch',
    value: { enabled: true, routingMode: 'EXPLICIT' },
  });
}

// --- Rückkanal (Callback-Credential) --------------------------------------------

export const CALLBACK_ROTATION_CONFIRMATION =
  'Das bisherige Callback-Token wird sofort ungültig. Wirklich rotieren?';

export interface N8nCallbackState {
  scopes: string[];
  configured: boolean;
  /** Ergebnis der letzten Rotation bzw. des Imports inkl. einmalig angezeigtem Credential. */
  result: CallbackCredentialResult | null;
}

export type N8nCallbackAction =
  | { type: 'scopes'; update: SetStateAction<string[]> }
  | { type: 'result'; update: SetStateAction<CallbackCredentialResult | null> }
  | { type: 'rotated'; result: CallbackCredentialResult }
  | { type: 'imported'; result: WorkflowImportActionResult };

export function createN8nCallbackState({
  initial,
  bundledWorkflows,
}: {
  initial: Pick<N8nBrowserConfig, 'callbackScopes' | 'callbackConfigured'>;
  bundledWorkflows: Pick<BundledWorkflowSummary, 'callbackScopes'>[];
}): N8nCallbackState {
  return {
    scopes: initial.callbackScopes.length
      ? initial.callbackScopes
      : [...new Set(bundledWorkflows.flatMap((workflow) => workflow.callbackScopes))],
    configured: initial.callbackConfigured,
    result: null,
  };
}

export function n8nCallbackReducer(
  state: N8nCallbackState,
  action: N8nCallbackAction,
): N8nCallbackState {
  switch (action.type) {
    case 'scopes':
      return withField(state, 'scopes', applyUpdate(state.scopes, action.update));
    case 'result':
      return withField(state, 'result', applyUpdate(state.result, action.update));
    case 'rotated':
      return {
        ...state,
        result: action.result,
        configured: state.configured || action.result.ok,
      };
    case 'imported': {
      const configured = state.configured || Boolean(action.result.callbackConfigured);
      const result = action.result.credential ? action.result : state.result;
      return configured === state.configured && result === state.result
        ? state
        : { ...state, configured, result };
    }
  }
}

// --- Workflows (Vorlagen, Status, Webhook-Erkennung) -----------------------------

export const WORKFLOW_LIST_FAILED = 'Workflow-Liste konnte nicht geladen werden.';
export const WEBHOOK_DISCOVERY_FAILED = 'Webhook-Erkennung fehlgeschlagen.';

export interface N8nWorkflowsState {
  selectedTemplates: string[];
  mailFrom: string;
  gwgOfficerEmail: string;
  workflows: N8nWorkflowRow[] | null;
  workflowError: string | null;
  discovered: N8nDiscoveredWebhookView[] | null;
  discoveryError: string | null;
  importResult: ActionResult | null;
}

type WorkflowListResult = ActionResult & { workflows?: N8nWorkflowRow[] };
type WebhookDiscoveryResult = ActionResult & { webhooks?: N8nDiscoveredWebhookView[] };

export type N8nWorkflowsAction =
  | { type: 'templates'; update: SetStateAction<string[]> }
  | { type: 'mail-from'; update: SetStateAction<string> }
  | { type: 'gwg-officer-email'; update: SetStateAction<string> }
  | { type: 'import-started' }
  | { type: 'imported'; result: ActionResult }
  /** Nachladen nach dem Import: nur Erfolg zählt, Fehler bleiben stumm. */
  | { type: 'workflows-refreshed'; result: WorkflowListResult }
  | { type: 'workflows-requested' }
  | { type: 'workflows-loaded'; result: WorkflowListResult }
  | { type: 'discovery-requested' }
  | { type: 'discovered'; result: WebhookDiscoveryResult };

export function createN8nWorkflowsState(
  bundledWorkflows: Pick<BundledWorkflowSummary, 'templateId'>[],
): N8nWorkflowsState {
  return {
    selectedTemplates: bundledWorkflows.map((workflow) => workflow.templateId),
    mailFrom: '',
    gwgOfficerEmail: '',
    workflows: null,
    workflowError: null,
    discovered: null,
    discoveryError: null,
    importResult: null,
  };
}

export function n8nWorkflowsReducer(
  state: N8nWorkflowsState,
  action: N8nWorkflowsAction,
): N8nWorkflowsState {
  switch (action.type) {
    case 'templates':
      return withField(
        state,
        'selectedTemplates',
        applyUpdate(state.selectedTemplates, action.update),
      );
    case 'mail-from':
      return withField(state, 'mailFrom', applyUpdate(state.mailFrom, action.update));
    case 'gwg-officer-email':
      return withField(state, 'gwgOfficerEmail', applyUpdate(state.gwgOfficerEmail, action.update));
    case 'import-started':
      return withField(state, 'importResult', null);
    case 'imported':
      return withField(state, 'importResult', action.result);
    case 'workflows-refreshed':
      return action.result.ok
        ? withField(state, 'workflows', action.result.workflows ?? [])
        : state;
    case 'workflows-requested':
      return withField(state, 'workflowError', null);
    case 'workflows-loaded':
      return action.result.ok
        ? withField(state, 'workflows', action.result.workflows ?? [])
        : withField(state, 'workflowError', action.result.error ?? WORKFLOW_LIST_FAILED);
    case 'discovery-requested':
      return withField(state, 'discoveryError', null);
    case 'discovered':
      return action.result.ok
        ? withField(state, 'discovered', action.result.webhooks ?? [])
        : withField(state, 'discoveryError', action.result.error ?? WEBHOOK_DISCOVERY_FAILED);
  }
}

/** Import-Payload in unveränderter Feldreihenfolge. */
export function workflowImportInput(
  state: Pick<N8nWorkflowsState, 'selectedTemplates' | 'mailFrom' | 'gwgOfficerEmail'>,
) {
  return {
    templateIds: state.selectedTemplates,
    smtpFrom: state.mailFrom,
    gwgOfficerEmail: state.gwgOfficerEmail,
  };
}

// --- Routen ------------------------------------------------------------------------

export const EMPTY_ROUTE: RouteDraft = {
  id: '',
  name: '',
  productionUrl: '',
  testUrl: '',
  workflowId: '',
  workflowName: '',
  workflowNodeId: '',
  source: 'CUSTOM',
  enabled: false,
  testMode: false,
  events: [],
};

export const ROUTE_DELETE_CONFIRMATION = 'Diese Route und ihre Event-Abonnements entfernen?';
const ROUTE_TEST_PENDING = 'Prüfung läuft…';

export interface N8nRoutesState {
  draft: RouteDraft;
  customEvent: string;
  /** Ergebnis von Speichern/Ein-Aus-Schalten/Löschen einer Route. */
  result: ActionResult | null;
  /** Ergebnisse je Routen-Karte: `<id>:toggle`, `<id>:prod:<event>`, `<id>:test:<event>`. */
  testResults: Record<string, ActionResult>;
}

export type N8nRoutesAction =
  | { type: 'draft'; update: SetStateAction<RouteDraft> }
  | { type: 'custom-event'; update: SetStateAction<string> }
  /** Bearbeiten bzw. Übernahme aus der Webhook-Erkennung öffnet den Editor vorbefüllt. */
  | { type: 'draft-loaded'; draft: RouteDraft }
  | { type: 'result-cleared' }
  | { type: 'saved'; result: ActionResult }
  | { type: 'toggled'; endpointId: string; result: ActionResult }
  | { type: 'deleted'; result: ActionResult }
  | { type: 'test-started'; key: string }
  | { type: 'tested'; key: string; result: ActionResult };

export function createN8nRoutesState(): N8nRoutesState {
  return { draft: EMPTY_ROUTE, customEvent: '', result: null, testResults: {} };
}

export function routeToggleKey(endpointId: string): string {
  return `${endpointId}:toggle`;
}

export function routeTestKey(endpointId: string, useTestUrl: boolean, eventName: string): string {
  return `${endpointId}:${useTestUrl ? 'test' : 'prod'}:${eventName}`;
}

export function n8nRoutesReducer(state: N8nRoutesState, action: N8nRoutesAction): N8nRoutesState {
  switch (action.type) {
    case 'draft':
      return withField(state, 'draft', applyUpdate(state.draft, action.update));
    case 'custom-event':
      return withField(state, 'customEvent', applyUpdate(state.customEvent, action.update));
    case 'draft-loaded':
      return { ...state, draft: action.draft, customEvent: '', result: null };
    case 'result-cleared':
      return withField(state, 'result', null);
    case 'saved':
      return action.result.ok
        ? { ...state, result: action.result, draft: EMPTY_ROUTE, customEvent: '' }
        : { ...state, result: action.result };
    case 'toggled':
      return {
        ...state,
        testResults: { ...state.testResults, [routeToggleKey(action.endpointId)]: action.result },
      };
    case 'deleted':
      return action.result.ok ? state : { ...state, result: action.result };
    case 'test-started':
      return {
        ...state,
        testResults: { ...state.testResults, [action.key]: pendingResult(ROUTE_TEST_PENDING) },
      };
    case 'tested':
      return { ...state, testResults: { ...state.testResults, [action.key]: action.result } };
  }
}

function routeSource(source: N8nEndpointView['source']): RouteDraft['source'] {
  return source === 'LEGACY' ? 'CUSTOM' : source;
}

/** Editor-Entwurf einer gespeicherten Route; Legacy-Routen werden als eigene Route gespeichert. */
export function routeDraftFromEndpoint(endpoint: N8nEndpointView): RouteDraft {
  return {
    id: endpoint.id,
    name: endpoint.name,
    productionUrl: endpoint.productionUrl,
    testUrl: endpoint.testUrl,
    workflowId: endpoint.workflowId,
    workflowName: endpoint.workflowName,
    workflowNodeId: endpoint.workflowNodeId,
    source: routeSource(endpoint.source),
    enabled: endpoint.enabled,
    testMode: endpoint.testMode,
    events: endpoint.events,
  };
}

/** Routenentwurf aus einem erkannten Webhook; Events nur aus dem bekannten Katalog. */
export function discoveredRouteDraft(
  item: N8nDiscoveredWebhookView,
  bundledWorkflows: BundledWorkflowSummary[],
  events: readonly N8nEventCatalogEntry[],
): RouteDraft {
  const managedWorkflow = bundledWorkflows.find((workflow) => workflow.name === item.workflowName);
  const allowedEvents = new Set<string>(events.map((event) => event.name));
  const inferredEvents = [...new Set([...(managedWorkflow?.events ?? []), item.path])].filter(
    (eventName) => allowedEvents.has(eventName),
  );
  return {
    id: '',
    name: `${item.workflowName} — ${item.nodeName}`.slice(0, 120),
    productionUrl: item.productionUrl,
    testUrl: item.testUrl,
    workflowId: item.workflowId,
    workflowName: item.workflowName,
    workflowNodeId: item.nodeId,
    source: managedWorkflow ? 'MANAGED' : 'DISCOVERED',
    enabled: item.workflowActive,
    testMode: false,
    events: inferredEvents,
  };
}

export function selectedDiscoveredRouteKey(draft: RouteDraft): string | null {
  return !draft.id && draft.workflowId && draft.workflowNodeId
    ? `${draft.workflowId}:${draft.workflowNodeId}`
    : null;
}

export function discoveredRouteCanBeSaved(draft: RouteDraft): boolean {
  return Boolean(draft.name && draft.productionUrl && draft.events.length > 0);
}

/** Speichern-Payload des Editors: Felder in Entwurfsreihenfolge, Flags nur wenn gesetzt. */
export function routeDraftFormData(draft: RouteDraft, customEvent: string): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(draft)) {
    if (key === 'events' || key === 'enabled' || key === 'testMode') continue;
    data.set(key, String(value));
  }
  if (draft.enabled) data.set('enabled', 'on');
  if (draft.testMode) data.set('testMode', 'on');
  for (const eventName of draft.events) data.append('events', eventName);
  if (customEvent.trim()) data.append('events', customEvent.trim());
  return data;
}

/** Ein-Klick-Schalter an der Routen-Karte: gespeicherte Route plus geänderte Flags. */
export function routeToggleFormData(
  endpoint: N8nEndpointView,
  patch: { enabled?: boolean; testMode?: boolean },
): FormData {
  const data = new FormData();
  data.set('id', endpoint.id);
  data.set('name', endpoint.name);
  data.set('productionUrl', endpoint.productionUrl);
  data.set('testUrl', endpoint.testUrl);
  data.set('workflowId', endpoint.workflowId);
  data.set('workflowName', endpoint.workflowName);
  data.set('workflowNodeId', endpoint.workflowNodeId);
  data.set('source', routeSource(endpoint.source));
  if (patch.enabled ?? endpoint.enabled) data.set('enabled', 'on');
  if (patch.testMode ?? endpoint.testMode) data.set('testMode', 'on');
  for (const eventName of endpoint.events) data.append('events', eventName);
  return data;
}

// --- Betrieb (Zustellungen, Events ohne Route) -----------------------------------

export const DELIVERY_ACKNOWLEDGE_CONFIRMATION =
  'Diesen Fehler ohne erneuten Versand administrativ abschließen? Die Zustellung wird als übersprungen markiert und die Entscheidung revisionsprotokolliert.';

export function deliveryRetryConfirmation(targetUrl: string): string {
  return `Zustellung erneut an dieses unveränderte Ziel senden?\n\n${targetUrl}`;
}

export function unroutedReplayConfirmation(eventName: string, occurredAt: string): string {
  return `Das gespeicherte Event „${eventName}“ vom ${fmtDateTimeShort(new Date(occurredAt))} enthält möglicherweise vertrauliche Daten. Jetzt an die aktuell konfigurierten Ziele senden?`;
}

export function unroutedSkipConfirmation(eventName: string): string {
  return `Event „${eventName}“ dauerhaft ohne n8n-Versand abschließen? Diese Entscheidung wird protokolliert.`;
}

type DeliveryStatusSource = Pick<N8nSetupStatus, 'failedDeliveries' | 'hasMoreFailedDeliveries'>;

export interface N8nDeliveriesState {
  /** Server-Stand, aus dem die nachladbare Fehlerliste zuletzt übernommen wurde. */
  source: DeliveryStatusSource;
  failedDeliveries: N8nRecentDeliveryView[];
  failedCursor: string | null;
  hasMoreFailedDeliveries: boolean;
  operationResult: ActionResult | null;
  retryResults: Record<string, ActionResult>;
  replayResults: Record<string, ActionResult>;
}

export type N8nDeliveriesAction =
  /** Neuer Server-Stand ersetzt die lokal nachgeladene Fehlerliste. */
  | { type: 'status-received'; status: DeliveryStatusSource }
  | { type: 'retry-pending'; deliveryId: string }
  | { type: 'retried'; deliveryId: string; result: ActionResult }
  | { type: 'acknowledge-pending' }
  | { type: 'acknowledged'; result: ActionResult }
  | { type: 'page-requested' }
  | { type: 'page-loaded'; result: N8nFailedDeliveryPageResult }
  | { type: 'replay-pending'; eventId: string }
  | { type: 'skip-pending'; eventId: string }
  | { type: 'replayed'; eventId: string; result: ActionResult };

function failedDeliveryList(status: DeliveryStatusSource) {
  return {
    source: status,
    failedDeliveries: status.failedDeliveries,
    failedCursor: status.failedDeliveries.at(-1)?.id ?? null,
    hasMoreFailedDeliveries: status.hasMoreFailedDeliveries,
  };
}

export function createN8nDeliveriesState(status: DeliveryStatusSource): N8nDeliveriesState {
  return {
    ...failedDeliveryList(status),
    operationResult: null,
    retryResults: {},
    replayResults: {},
  };
}

/** Nur eine neue Fehlerliste vom Server setzt die lokal nachgeladenen Seiten zurück. */
export function deliveryStatusChanged(
  state: Pick<N8nDeliveriesState, 'source'>,
  status: DeliveryStatusSource,
): boolean {
  return (
    state.source.failedDeliveries !== status.failedDeliveries ||
    state.source.hasMoreFailedDeliveries !== status.hasMoreFailedDeliveries
  );
}

/** Hängt eine nachgeladene Seite an; bereits sichtbare Zustellungen bleiben einfach. */
export function appendFailedDeliveries(
  current: N8nRecentDeliveryView[],
  next: N8nRecentDeliveryView[],
): N8nRecentDeliveryView[] {
  const known = new Set(current.map((delivery) => delivery.id));
  return [...current, ...next.filter((delivery) => !known.has(delivery.id))];
}

export function n8nDeliveriesReducer(
  state: N8nDeliveriesState,
  action: N8nDeliveriesAction,
): N8nDeliveriesState {
  switch (action.type) {
    case 'status-received':
      return { ...state, ...failedDeliveryList(action.status) };
    case 'retry-pending':
      return {
        ...state,
        retryResults: {
          ...state.retryResults,
          [action.deliveryId]: pendingResult('Wird eingeplant…'),
        },
      };
    case 'retried':
      return {
        ...state,
        retryResults: { ...state.retryResults, [action.deliveryId]: action.result },
      };
    case 'acknowledge-pending':
      return { ...state, operationResult: pendingResult('Fehler wird quittiert…') };
    case 'acknowledged':
      return { ...state, operationResult: action.result };
    case 'page-requested':
      return withField(state, 'operationResult', null);
    case 'page-loaded': {
      if (!action.result.ok) return { ...state, operationResult: action.result };
      return {
        ...state,
        failedDeliveries: appendFailedDeliveries(
          state.failedDeliveries,
          action.result.deliveries ?? [],
        ),
        failedCursor: action.result.nextCursor ?? null,
        hasMoreFailedDeliveries: Boolean(action.result.nextCursor),
      };
    }
    case 'replay-pending':
      return {
        ...state,
        replayResults: {
          ...state.replayResults,
          [action.eventId]: pendingResult('Wird den aktuellen Routen zugeordnet…'),
        },
      };
    case 'skip-pending':
      return {
        ...state,
        replayResults: {
          ...state.replayResults,
          [action.eventId]: pendingResult('Wird abgeschlossen…'),
        },
      };
    case 'replayed':
      return {
        ...state,
        replayResults: { ...state.replayResults, [action.eventId]: action.result },
      };
  }
}
