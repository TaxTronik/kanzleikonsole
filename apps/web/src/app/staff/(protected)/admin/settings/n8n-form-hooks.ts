'use client';

// Bereichs-Hooks des n8n-Adminformulars. Jeder Hook hält den Zustand seines
// Bereichs in einem reinen Reducer (n8n-form-state.ts) und verdrahtet nur die
// Server-Actions. Alle Hooks teilen die eine Transition des Formulars und damit
// die bestehende globale Busy-Semantik.

import {
  useCallback,
  useEffect,
  useReducer,
  useState,
  type Dispatch,
  type FormEvent,
  type SetStateAction,
  type TransitionStartFunction,
} from 'react';
import type { N8nEventCatalogEntry } from '@taxtronik/n8n-shared';
import type { N8nEndpointView, N8nSetupStatus } from '@/server/n8n/status';
import {
  acknowledgeN8nDeliveryAction,
  deleteN8nEndpointAction,
  discoverN8nWebhooksAction,
  importWorkflowsAction,
  listFailedN8nDeliveriesAction,
  listWorkflowsAction,
  replayUnroutedN8nEventAction,
  retryN8nDeliveryAction,
  rotateN8nCallbackCredentialAction,
  saveN8nEndpointAction,
  skipUnroutedN8nEventAction,
  testN8nEndpointAction,
  type CallbackCredentialResult,
  type N8nDiscoveredWebhookView,
  type WorkflowImportActionResult,
} from './n8n-actions';
import type { N8nConnectionAction } from './n8n-connection-state';
import {
  CALLBACK_ROTATION_CONFIRMATION,
  DELIVERY_ACKNOWLEDGE_CONFIRMATION,
  ROUTE_DELETE_CONFIRMATION,
  createN8nCallbackState,
  createN8nDeliveriesState,
  createN8nRoutesState,
  createN8nWorkflowsState,
  deliveryRetryConfirmation,
  deliveryStatusChanged,
  discoveredRouteDraft,
  n8nCallbackReducer,
  n8nDeliveriesReducer,
  n8nRoutesReducer,
  n8nWorkflowsReducer,
  routeDraftFormData,
  routeDraftFromEndpoint,
  routeTestKey,
  routeToggleFormData,
  syncConnectionActivation,
  unroutedReplayConfirmation,
  unroutedSkipConfirmation,
  workflowImportInput,
} from './n8n-form-state';
import type { BundledWorkflowSummary, N8nBrowserConfig, RouteDraft } from './n8n-form-types';
import { useConfirmedAction } from './use-confirmed-action';

/** Gemeinsame Laufzeit aller Bereiche: eine Transition, ein Router. */
export interface N8nFormRuntime {
  startTransition: TransitionStartFunction;
  router: { refresh: () => void };
}

/** Kopier-Rückmeldung („Kopiert“) für 1,5 Sekunden. */
export function useCopyFeedback() {
  const [copied, setCopied] = useState<string | null>(null);
  async function copy(label: string, value: string) {
    await navigator.clipboard.writeText(value);
    setCopied(label);
    window.setTimeout(() => setCopied(null), 1_500);
  }
  return { copied, copy };
}

/** Stufe 2: Scopes, Rotation und einmalige Anzeige des Callback-Credentials. */
export function useN8nCallbackCredentials(
  initial: N8nBrowserConfig,
  bundledWorkflows: BundledWorkflowSummary[],
  { startTransition, router }: N8nFormRuntime,
) {
  const [state, dispatch] = useReducer(
    n8nCallbackReducer,
    { initial, bundledWorkflows },
    createN8nCallbackState,
  );
  const setCallbackScopes = useCallback(
    (update: SetStateAction<string[]>) => dispatch({ type: 'scopes', update }),
    [],
  );
  const setCallbackResult = useCallback(
    (update: SetStateAction<CallbackCredentialResult | null>) =>
      dispatch({ type: 'result', update }),
    [],
  );
  const recordImport = useCallback(
    (result: WorkflowImportActionResult) => dispatch({ type: 'imported', result }),
    [],
  );

  // Das Klartext-Credential bleibt höchstens fünf Minuten im Browser-State.
  useEffect(() => {
    if (!state.result?.credential) return;
    const timeout = window.setTimeout(() => dispatch({ type: 'result', update: null }), 5 * 60_000);
    return () => window.clearTimeout(timeout);
  }, [state.result]);

  const rotateCallback = useConfirmedAction({
    startTransition,
    confirmation: state.configured ? CALLBACK_ROTATION_CONFIRMATION : null,
    action: () => rotateN8nCallbackCredentialAction(state.scopes),
    onPending: () => dispatch({ type: 'result', update: null }),
    onResult: (result) => {
      dispatch({ type: 'rotated', result });
      if (result.ok) router.refresh();
    },
  });

  return {
    callbackScopes: state.scopes,
    setCallbackScopes,
    callbackConfigured: state.configured,
    callbackResult: state.result,
    setCallbackResult,
    rotateCallback,
    recordImport,
  };
}

/** Stufe 3: Vorlagenimport, Workflow-Status und Webhook-Erkennung. */
export function useN8nWorkflowSetup(
  bundledWorkflows: BundledWorkflowSummary[],
  { startTransition, router }: N8nFormRuntime,
  onImported: (result: WorkflowImportActionResult) => void,
) {
  const [state, dispatch] = useReducer(
    n8nWorkflowsReducer,
    bundledWorkflows,
    createN8nWorkflowsState,
  );
  const setSelectedTemplates = useCallback(
    (update: SetStateAction<string[]>) => dispatch({ type: 'templates', update }),
    [],
  );
  const setN8nMailFrom = useCallback(
    (update: SetStateAction<string>) => dispatch({ type: 'mail-from', update }),
    [],
  );
  const setGwgOfficerEmail = useCallback(
    (update: SetStateAction<string>) => dispatch({ type: 'gwg-officer-email', update }),
    [],
  );

  function loadWorkflows() {
    dispatch({ type: 'workflows-requested' });
    startTransition(async () => {
      const result = await listWorkflowsAction();
      dispatch({ type: 'workflows-loaded', result });
    });
  }

  function importWorkflows() {
    dispatch({ type: 'import-started' });
    startTransition(async () => {
      const result = await importWorkflowsAction(workflowImportInput(state));
      dispatch({ type: 'imported', result });
      onImported(result);
      const list = await listWorkflowsAction();
      dispatch({ type: 'workflows-refreshed', result: list });
      router.refresh();
    });
  }

  function discoverWebhooks() {
    dispatch({ type: 'discovery-requested' });
    startTransition(async () => {
      const result = await discoverN8nWebhooksAction();
      dispatch({ type: 'discovered', result });
    });
  }

  return {
    selectedTemplates: state.selectedTemplates,
    setSelectedTemplates,
    n8nMailFrom: state.mailFrom,
    setN8nMailFrom,
    gwgOfficerEmail: state.gwgOfficerEmail,
    setGwgOfficerEmail,
    workflows: state.workflows,
    workflowError: state.workflowError,
    discovered: state.discovered,
    discoveryError: state.discoveryError,
    importResult: state.importResult,
    loadWorkflows,
    importWorkflows,
    discoverWebhooks,
  };
}

/** Stufe 4: Routen-Editor, Ein-Klick-Schalter, Tests und Löschen. */
export function useN8nRoutes(
  {
    bundledWorkflows,
    events,
    dispatchConnection,
  }: {
    bundledWorkflows: BundledWorkflowSummary[];
    events: readonly N8nEventCatalogEntry[];
    dispatchConnection: Dispatch<N8nConnectionAction>;
  },
  { startTransition, router }: N8nFormRuntime,
) {
  const [state, dispatch] = useReducer(n8nRoutesReducer, undefined, createN8nRoutesState);
  const setRouteDraft = useCallback(
    (update: SetStateAction<RouteDraft>) => dispatch({ type: 'draft', update }),
    [],
  );
  const setCustomEvent = useCallback(
    (update: SetStateAction<string>) => dispatch({ type: 'custom-event', update }),
    [],
  );

  // Editor ist ein Modal — öffnet automatisch über draftPrefilled.
  function editRoute(endpoint: N8nEndpointView) {
    dispatch({ type: 'draft-loaded', draft: routeDraftFromEndpoint(endpoint) });
  }

  // Bekannte Events sind vorausgewählt; unbekannte wählt man im Editor nach.
  function selectDiscovered(item: N8nDiscoveredWebhookView) {
    dispatch({ type: 'draft-loaded', draft: discoveredRouteDraft(item, bundledWorkflows, events) });
  }

  function persistRouteDraft() {
    dispatch({ type: 'result-cleared' });
    startTransition(async () => {
      const data = routeDraftFormData(state.draft, state.customEvent);
      const result = await saveN8nEndpointAction(null, data);
      dispatch({ type: 'saved', result });
      if (result.ok) {
        syncConnectionActivation(dispatchConnection, result);
        router.refresh();
      }
    });
  }

  function saveRoute(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    persistRouteDraft();
  }

  // Ein-Klick-Aktivierung/Deaktivierung direkt an der Routen-Karte. Dieselbe
  // Änderung ist auch über Bearbeiten → Route aktiv → Speichern möglich.
  function toggleRoute(
    endpoint: N8nEndpointView,
    patch: { enabled?: boolean; testMode?: boolean },
  ) {
    dispatch({ type: 'result-cleared' });
    startTransition(async () => {
      const result = await saveN8nEndpointAction(null, routeToggleFormData(endpoint, patch));
      dispatch({ type: 'toggled', endpointId: endpoint.id, result });
      if (result.ok) {
        syncConnectionActivation(dispatchConnection, result);
        router.refresh();
      }
    });
  }

  const deleteRoute = useConfirmedAction({
    startTransition,
    confirmation: ROUTE_DELETE_CONFIRMATION,
    action: (endpointId: string) => deleteN8nEndpointAction(endpointId),
    onResult: (result) => {
      dispatch({ type: 'deleted', result });
      router.refresh();
    },
  });

  function testRoute(endpointId: string, useTestUrl: boolean, eventName: string) {
    const key = routeTestKey(endpointId, useTestUrl, eventName);
    dispatch({ type: 'test-started', key });
    startTransition(async () => {
      const result = await testN8nEndpointAction(endpointId, useTestUrl, eventName);
      dispatch({ type: 'tested', key, result });
      router.refresh();
    });
  }

  return {
    routeDraft: state.draft,
    setRouteDraft,
    customEvent: state.customEvent,
    setCustomEvent,
    routeResult: state.result,
    testResult: state.testResults,
    editRoute,
    selectDiscovered,
    persistRouteDraft,
    saveRoute,
    toggleRoute,
    deleteRoute,
    testRoute,
  };
}

/** Stufe 5: fehlgeschlagene Zustellungen und Events ohne aktive Route. */
export function useN8nDeliveryOperations(
  status: N8nSetupStatus,
  { startTransition, router }: N8nFormRuntime,
) {
  const [state, dispatch] = useReducer(n8nDeliveriesReducer, status, createN8nDeliveriesState);
  if (deliveryStatusChanged(state, status)) {
    dispatch({ type: 'status-received', status });
  }

  const retryDelivery = useConfirmedAction({
    startTransition,
    confirmation: (_deliveryId: string, targetUrl: string) => deliveryRetryConfirmation(targetUrl),
    action: (deliveryId: string, _targetUrl: string) => retryN8nDeliveryAction(deliveryId),
    onPending: (deliveryId) => dispatch({ type: 'retry-pending', deliveryId }),
    onResult: (result, deliveryId) => {
      dispatch({ type: 'retried', deliveryId, result });
      router.refresh();
    },
  });

  const acknowledgeDelivery = useConfirmedAction({
    startTransition,
    confirmation: DELIVERY_ACKNOWLEDGE_CONFIRMATION,
    action: (deliveryId: string) => acknowledgeN8nDeliveryAction(deliveryId),
    onPending: () => dispatch({ type: 'acknowledge-pending' }),
    onResult: (result) => {
      dispatch({ type: 'acknowledged', result });
      router.refresh();
    },
  });

  function loadMoreFailedDeliveries() {
    const cursor = state.failedCursor;
    if (!cursor) return;
    dispatch({ type: 'page-requested' });
    startTransition(async () => {
      const result = await listFailedN8nDeliveriesAction(cursor);
      dispatch({ type: 'page-loaded', result });
    });
  }

  const replayUnroutedEvent = useConfirmedAction({
    startTransition,
    confirmation: (_eventId: string, eventName: string, occurredAt: string) =>
      unroutedReplayConfirmation(eventName, occurredAt),
    action: (eventId: string, _eventName: string, _occurredAt: string) =>
      replayUnroutedN8nEventAction(eventId),
    onPending: (eventId) => dispatch({ type: 'replay-pending', eventId }),
    onResult: (result, eventId) => {
      dispatch({ type: 'replayed', eventId, result });
      router.refresh();
    },
  });

  const skipUnroutedEvent = useConfirmedAction({
    startTransition,
    confirmation: (_eventId: string, eventName: string) => unroutedSkipConfirmation(eventName),
    action: (eventId: string, _eventName: string) => skipUnroutedN8nEventAction(eventId),
    onPending: (eventId) => dispatch({ type: 'skip-pending', eventId }),
    onResult: (result, eventId) => {
      dispatch({ type: 'replayed', eventId, result });
      router.refresh();
    },
  });

  return {
    failedDeliveries: state.failedDeliveries,
    failedCursor: state.failedCursor,
    hasMoreFailedDeliveries: state.hasMoreFailedDeliveries,
    deliveryOperationResult: state.operationResult,
    retryResult: state.retryResults,
    replayResult: state.replayResults,
    retryDelivery,
    acknowledgeDelivery,
    loadMoreFailedDeliveries,
    replayUnroutedEvent,
    skipUnroutedEvent,
  };
}
