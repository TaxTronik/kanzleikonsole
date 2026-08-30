'use client';

import { ExternalLink, Trash2 } from 'lucide-react';
import {
  useActionState,
  useEffect,
  useReducer,
  useState,
  useTransition,
  type Dispatch,
} from 'react';
import { useRouter } from 'next/navigation';
import type { N8nEventCatalogEntry } from '@taxtronik/n8n-shared';
import type { N8nEndpointView, N8nSetupStatus } from '@/server/n8n/status';
import { fmtDateTimeShort } from '@/lib/fmt';
import {
  acknowledgeN8nDeliveryAction,
  deleteN8nEndpointAction,
  discoverN8nWebhooksAction,
  generateSigningSecretAction,
  importWorkflowsAction,
  listFailedN8nDeliveriesAction,
  listWorkflowsAction,
  replayUnroutedN8nEventAction,
  resetN8nAction,
  retryN8nDeliveryAction,
  rotateN8nCallbackCredentialAction,
  saveN8nAction,
  saveN8nEndpointAction,
  skipUnroutedN8nEventAction,
  testN8nApiAction,
  testN8nEndpointAction,
  type ActionResult,
  type CallbackCredentialResult,
  type N8nDiscoveredWebhookView,
  type N8nWorkflowRow,
} from './n8n-actions';
import {
  createN8nConnectionState,
  n8nConnectionReducer,
  type N8nConnectionAction,
  type N8nConnectionState,
} from './n8n-connection-state';
import { Stage } from '@/components/stage';
import { withActiveStep } from '@/components/stepper';
import { DeliveryOperationsSection } from './delivery-operations-section';
import { EMPTY_ROUTE, RouteEditorSection, type RouteDraft } from './route-editor-section';
import { useConfirmedAction } from './use-confirmed-action';
import { N8nSetupOverview } from './n8n-setup-overview';
import { N8nConnectionSection } from './n8n-connection-section';
import { N8nCallbackCredentialsSection } from './n8n-callback-credentials-section';
import { N8nWorkflowsSection } from './n8n-workflows-section';
import type { BundledWorkflowSummary, N8nBrowserConfig } from './n8n-form-types';

export type { N8nBrowserConfig } from './n8n-form-types';

interface Props {
  initial: N8nBrowserConfig;
  status: N8nSetupStatus;
  events: readonly N8nEventCatalogEntry[];
  bundledWorkflows: BundledWorkflowSummary[];
}

function urlOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}

function syncConnectionActivation(
  dispatch: Dispatch<N8nConnectionAction>,
  result: ActionResult,
): void {
  if (!result.connectionActivated) return;
  dispatch({
    type: 'patch',
    value: { enabled: true, routingMode: 'EXPLICIT' },
  });
}

function isExplicitConnectionActive(
  connection: Pick<N8nConnectionState, 'enabled' | 'routingMode'>,
): boolean {
  return connection.enabled && connection.routingMode === 'EXPLICIT';
}

function discoveredRouteDraft(
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

function selectedDiscoveredRouteKey(draft: RouteDraft): string | null {
  return !draft.id && draft.workflowId && draft.workflowNodeId
    ? `${draft.workflowId}:${draft.workflowNodeId}`
    : null;
}

function discoveredRouteCanBeSaved(draft: RouteDraft): boolean {
  return Boolean(draft.name && draft.productionUrl && draft.events.length > 0);
}

/** Derive only the five visible setup stages; action payloads remain in N8nForm. */
function n8nSetupProgress(
  initial: N8nBrowserConfig,
  status: N8nSetupStatus,
  callbackConfigured: boolean,
) {
  const deliberatelyDisabled = Boolean(
    initial.connectionId && initial.routingMode === 'DISABLED' && !initial.enabled,
  );
  const verifiedActiveRoutes = status.endpoints.filter(
    (endpoint) => endpoint.enabled && endpoint.verificationOk === true,
  ).length;
  // Fünf Stufen, 1:1 auf die Stage-Karten darunter abgebildet (vorher:
  // 4 Pillen vs. 5 nummerierte Sektionen mit verschobener Zuordnung).
  const workflowsReady =
    status.endpoints.some((endpoint) => endpoint.workflowId) || verifiedActiveRoutes > 0;
  const setupSteps = [
    { label: 'Verbinden', done: Boolean(initial.connectionId) },
    {
      label: 'Rückkanal',
      done: deliberatelyDisabled || initial.hasSigningSecret || callbackConfigured,
    },
    { label: 'Workflows', done: deliberatelyDisabled || workflowsReady },
    { label: 'Routen', done: deliberatelyDisabled || verifiedActiveRoutes > 0 },
    {
      label: 'Betrieb',
      done:
        deliberatelyDisabled ||
        (initial.enabled &&
          initial.routingMode === 'EXPLICIT' &&
          verifiedActiveRoutes > 0 &&
          status.deliveryCounts.pending === 0 &&
          status.deliveryCounts.failed === 0 &&
          status.deliveryCounts.unrouted === 0),
    },
  ];
  return { setupSteps, workflowsReady, verifiedActiveRoutes };
}

export function N8nForm({ initial, status, events, bundledWorkflows }: Props) {
  const router = useRouter();
  const [connection, dispatchConnection] = useReducer(
    n8nConnectionReducer,
    initial,
    createN8nConnectionState,
  );
  const {
    name,
    kind,
    routingMode,
    enabled,
    uiBaseUrl,
    callbackBaseUrl,
    webhookBaseUrl,
    apiBaseUrl,
    apiKey,
    keepApiKey,
    hmacSecret,
    keepHmac,
  } = connection;
  const [callbackScopes, setCallbackScopes] = useState<string[]>(
    initial.callbackScopes.length
      ? initial.callbackScopes
      : [...new Set(bundledWorkflows.flatMap((workflow) => workflow.callbackScopes))],
  );
  const [callbackConfigured, setCallbackConfigured] = useState(initial.callbackConfigured);

  const [saveState, saveAction, saving] = useActionState<ActionResult | null, FormData>(
    saveN8nAction,
    null,
  );
  const [busy, startTransition] = useTransition();
  const [apiResult, setApiResult] = useState<ActionResult | null>(null);
  const [callbackResult, setCallbackResult] = useState<CallbackCredentialResult | null>(null);
  const [importResult, setImportResult] = useState<ActionResult | null>(null);
  const [selectedTemplates, setSelectedTemplates] = useState<string[]>(
    bundledWorkflows.map((workflow) => workflow.templateId),
  );
  const [n8nMailFrom, setN8nMailFrom] = useState('');
  const [gwgOfficerEmail, setGwgOfficerEmail] = useState('');
  const [workflows, setWorkflows] = useState<N8nWorkflowRow[] | null>(null);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [discovered, setDiscovered] = useState<N8nDiscoveredWebhookView[] | null>(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [routeDraft, setRouteDraft] = useState<RouteDraft>(EMPTY_ROUTE);
  const [customEvent, setCustomEvent] = useState('');
  const [routeResult, setRouteResult] = useState<ActionResult | null>(null);
  const [testResult, setTestResult] = useState<Record<string, ActionResult>>({});
  const [retryResult, setRetryResult] = useState<Record<string, ActionResult>>({});
  const [deliveryOperationResult, setDeliveryOperationResult] = useState<ActionResult | null>(null);
  const [failedDeliveries, setFailedDeliveries] = useState(status.failedDeliveries);
  const [failedCursor, setFailedCursor] = useState<string | null>(
    status.failedDeliveries.at(-1)?.id ?? null,
  );
  const [hasMoreFailedDeliveries, setHasMoreFailedDeliveries] = useState(
    status.hasMoreFailedDeliveries,
  );
  const [replayResult, setReplayResult] = useState<Record<string, ActionResult>>({});
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (saveState?.ok) {
      dispatchConnection({ type: 'saved' });
      router.refresh();
    }
  }, [router, saveState]);

  useEffect(() => {
    if (!callbackResult?.credential) return;
    const timeout = window.setTimeout(() => setCallbackResult(null), 5 * 60_000);
    return () => window.clearTimeout(timeout);
  }, [callbackResult]);

  useEffect(() => {
    setFailedDeliveries(status.failedDeliveries);
    setFailedCursor(status.failedDeliveries.at(-1)?.id ?? null);
    setHasMoreFailedDeliveries(status.hasMoreFailedDeliveries);
  }, [status.failedDeliveries, status.hasMoreFailedDeliveries]);

  // Instanzwechsel nur, wenn tatsächlich eine API-URL gespeichert ist: mit
  // leerer gespeicherter URL (urlOrigin('') === '') zählte früher JEDE Eingabe
  // als Wechsel — Key-Eingabe und Test waren dann dauerhaft gesperrt.
  const initialApiOrigin = urlOrigin(initial.apiBaseUrl);
  const apiInstanceChanged = Boolean(
    initial.hasApiKey && initialApiOrigin !== '' && urlOrigin(apiBaseUrl) !== initialApiOrigin,
  );
  const { setupSteps, workflowsReady, verifiedActiveRoutes } = n8nSetupProgress(
    initial,
    status,
    callbackConfigured,
  );
  const stageStates = withActiveStep(setupSteps);

  function connectionFormData(): FormData {
    const data = new FormData();
    data.set('name', name);
    data.set('kind', kind);
    data.set('routingMode', routingMode);
    if (enabled && routingMode !== 'DISABLED') data.set('enabled', 'on');
    data.set('uiBaseUrl', uiBaseUrl);
    data.set('callbackBaseUrl', callbackBaseUrl);
    data.set('webhookBaseUrl', webhookBaseUrl);
    data.set('apiBaseUrl', apiBaseUrl);
    data.set('apiKey', apiKey);
    data.set('hmacSecret', hmacSecret);
    if (keepApiKey) data.set('keepApiKey', 'on');
    if (keepHmac) data.set('keepHmac', 'on');
    return data;
  }

  function testApi() {
    setApiResult(null);
    startTransition(async () => setApiResult(await testN8nApiAction(null, connectionFormData())));
  }

  function generateSecret() {
    startTransition(async () => {
      const result = await generateSigningSecretAction();
      if (result.ok && result.secret) {
        dispatchConnection({ type: 'generated-signing-secret', secret: result.secret });
      }
    });
  }

  const rotateCallback = useConfirmedAction({
    startTransition,
    confirmation: callbackConfigured
      ? 'Das bisherige Callback-Token wird sofort ungültig. Wirklich rotieren?'
      : null,
    action: () => rotateN8nCallbackCredentialAction(callbackScopes),
    onPending: () => setCallbackResult(null),
    onResult: (result) => {
      setCallbackResult(result);
      if (result.ok) {
        setCallbackConfigured(true);
        router.refresh();
      }
    },
  });

  function loadWorkflows() {
    setWorkflowError(null);
    startTransition(async () => {
      const result = await listWorkflowsAction();
      if (result.ok) setWorkflows(result.workflows ?? []);
      else setWorkflowError(result.error ?? 'Workflow-Liste konnte nicht geladen werden.');
    });
  }

  function importWorkflows() {
    setImportResult(null);
    startTransition(async () => {
      const result = await importWorkflowsAction({
        templateIds: selectedTemplates,
        smtpFrom: n8nMailFrom,
        gwgOfficerEmail,
      });
      setImportResult(result);
      if (result.callbackConfigured) setCallbackConfigured(true);
      if (result.credential) setCallbackResult(result);
      const list = await listWorkflowsAction();
      if (list.ok) setWorkflows(list.workflows ?? []);
      router.refresh();
    });
  }

  function discoverWebhooks() {
    setDiscoveryError(null);
    startTransition(async () => {
      const result = await discoverN8nWebhooksAction();
      if (result.ok) setDiscovered(result.webhooks ?? []);
      else setDiscoveryError(result.error ?? 'Webhook-Erkennung fehlgeschlagen.');
    });
  }

  function editRoute(endpoint: N8nEndpointView) {
    setRouteDraft({
      id: endpoint.id,
      name: endpoint.name,
      productionUrl: endpoint.productionUrl,
      testUrl: endpoint.testUrl,
      workflowId: endpoint.workflowId,
      workflowName: endpoint.workflowName,
      workflowNodeId: endpoint.workflowNodeId,
      source: endpoint.source === 'LEGACY' ? 'CUSTOM' : endpoint.source,
      enabled: endpoint.enabled,
      testMode: endpoint.testMode,
      events: endpoint.events,
    });
    setCustomEvent('');
    setRouteResult(null);
    // Editor ist ein Modal — öffnet automatisch über draftPrefilled.
  }

  function selectDiscovered(item: N8nDiscoveredWebhookView) {
    const draft = discoveredRouteDraft(item, bundledWorkflows, events);
    setRouteDraft(draft);
    setCustomEvent('');
    setRouteResult(null);
    // Editor-Modal öffnet automatisch über draftPrefilled (bekannte Events
    // vorausgewählt; unbekannte wählt man dort manuell nach).
  }

  function persistRouteDraft() {
    setRouteResult(null);
    startTransition(async () => {
      const data = new FormData();
      for (const [key, value] of Object.entries(routeDraft)) {
        if (key === 'events' || key === 'enabled' || key === 'testMode') continue;
        data.set(key, String(value));
      }
      if (routeDraft.enabled) data.set('enabled', 'on');
      if (routeDraft.testMode) data.set('testMode', 'on');
      for (const eventName of routeDraft.events) data.append('events', eventName);
      if (customEvent.trim()) data.append('events', customEvent.trim());
      const result = await saveN8nEndpointAction(null, data);
      setRouteResult(result);
      if (result.ok) {
        syncConnectionActivation(dispatchConnection, result);
        setRouteDraft(EMPTY_ROUTE);
        setCustomEvent('');
        router.refresh();
      }
    });
  }

  function saveRoute(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    persistRouteDraft();
  }

  // Ein-Klick-Aktivierung/Deaktivierung direkt an der Routen-Karte. Dieselbe
  // Änderung ist auch über Bearbeiten → Route aktiv → Speichern möglich.
  function toggleRoute(
    endpoint: N8nEndpointView,
    patch: { enabled?: boolean; testMode?: boolean },
  ) {
    setRouteResult(null);
    startTransition(async () => {
      const data = new FormData();
      data.set('id', endpoint.id);
      data.set('name', endpoint.name);
      data.set('productionUrl', endpoint.productionUrl);
      data.set('testUrl', endpoint.testUrl);
      data.set('workflowId', endpoint.workflowId);
      data.set('workflowName', endpoint.workflowName);
      data.set('workflowNodeId', endpoint.workflowNodeId);
      data.set('source', endpoint.source === 'LEGACY' ? 'CUSTOM' : endpoint.source);
      if (patch.enabled ?? endpoint.enabled) data.set('enabled', 'on');
      if (patch.testMode ?? endpoint.testMode) data.set('testMode', 'on');
      for (const eventName of endpoint.events) data.append('events', eventName);
      const result = await saveN8nEndpointAction(null, data);
      setTestResult((current) => ({ ...current, [`${endpoint.id}:toggle`]: result }));
      if (result.ok) {
        syncConnectionActivation(dispatchConnection, result);
        router.refresh();
      }
    });
  }

  const deleteRoute = useConfirmedAction({
    startTransition,
    confirmation: 'Diese Route und ihre Event-Abonnements entfernen?',
    action: (endpointId: string) => deleteN8nEndpointAction(endpointId),
    onResult: (result) => {
      if (!result.ok) setRouteResult(result);
      router.refresh();
    },
  });

  function testRoute(endpointId: string, useTestUrl: boolean, eventName: string) {
    const key = `${endpointId}:${useTestUrl ? 'test' : 'prod'}:${eventName}`;
    setTestResult((current) => ({ ...current, [key]: { ok: true, message: 'Prüfung läuft…' } }));
    startTransition(async () => {
      const result = await testN8nEndpointAction(endpointId, useTestUrl, eventName);
      setTestResult((current) => ({ ...current, [key]: result }));
      router.refresh();
    });
  }

  const retryDelivery = useConfirmedAction({
    startTransition,
    confirmation: (_deliveryId: string, targetUrl: string) =>
      `Zustellung erneut an dieses unveränderte Ziel senden?\n\n${targetUrl}`,
    action: (deliveryId: string, _targetUrl: string) => retryN8nDeliveryAction(deliveryId),
    onPending: (deliveryId) =>
      setRetryResult((current) => ({
        ...current,
        [deliveryId]: { ok: true, message: 'Wird eingeplant…' },
      })),
    onResult: (result, deliveryId) => {
      setRetryResult((current) => ({ ...current, [deliveryId]: result }));
      router.refresh();
    },
  });

  const acknowledgeDelivery = useConfirmedAction({
    startTransition,
    confirmation:
      'Diesen Fehler ohne erneuten Versand administrativ abschließen? Die Zustellung wird als übersprungen markiert und die Entscheidung revisionsprotokolliert.',
    action: (deliveryId: string) => acknowledgeN8nDeliveryAction(deliveryId),
    onPending: () => setDeliveryOperationResult({ ok: true, message: 'Fehler wird quittiert…' }),
    onResult: (result) => {
      setDeliveryOperationResult(result);
      router.refresh();
    },
  });

  function loadMoreFailedDeliveries() {
    if (!failedCursor) return;
    setDeliveryOperationResult(null);
    startTransition(async () => {
      const result = await listFailedN8nDeliveriesAction(failedCursor);
      if (!result.ok) {
        setDeliveryOperationResult(result);
        return;
      }
      const next = result.deliveries ?? [];
      setFailedDeliveries((current) => {
        const known = new Set(current.map((delivery) => delivery.id));
        return [...current, ...next.filter((delivery) => !known.has(delivery.id))];
      });
      setFailedCursor(result.nextCursor ?? null);
      setHasMoreFailedDeliveries(Boolean(result.nextCursor));
    });
  }

  const replayUnroutedEvent = useConfirmedAction({
    startTransition,
    confirmation: (_eventId: string, eventName: string, occurredAt: string) =>
      `Das gespeicherte Event „${eventName}“ vom ${fmtDateTimeShort(new Date(occurredAt))} enthält möglicherweise vertrauliche Daten. Jetzt an die aktuell konfigurierten Ziele senden?`,
    action: (eventId: string, _eventName: string, _occurredAt: string) =>
      replayUnroutedN8nEventAction(eventId),
    onPending: (eventId) =>
      setReplayResult((current) => ({
        ...current,
        [eventId]: { ok: true, message: 'Wird den aktuellen Routen zugeordnet…' },
      })),
    onResult: (result, eventId) => {
      setReplayResult((current) => ({ ...current, [eventId]: result }));
      router.refresh();
    },
  });

  const skipUnroutedEvent = useConfirmedAction({
    startTransition,
    confirmation: (_eventId: string, eventName: string) =>
      `Event „${eventName}“ dauerhaft ohne n8n-Versand abschließen? Diese Entscheidung wird protokolliert.`,
    action: (eventId: string, _eventName: string) => skipUnroutedN8nEventAction(eventId),
    onPending: (eventId) =>
      setReplayResult((current) => ({
        ...current,
        [eventId]: { ok: true, message: 'Wird abgeschlossen…' },
      })),
    onResult: (result, eventId) => {
      setReplayResult((current) => ({ ...current, [eventId]: result }));
      router.refresh();
    },
  });

  async function copy(label: string, value: string) {
    await navigator.clipboard.writeText(value);
    setCopied(label);
    window.setTimeout(() => setCopied(null), 1_500);
  }

  const resetConnection = useConfirmedAction({
    startTransition,
    confirmation: 'n8n deaktivieren und alle Credentials sowie Routen entfernen?',
    action: () => resetN8nAction(),
    onResult: () => window.location.reload(),
  });

  return (
    <div className="space-y-4">
      <N8nSetupOverview initial={initial} status={status} setupSteps={setupSteps} />

      <Stage
        num={1}
        state={stageStates[0]!.state}
        title="n8n-Instanz verbinden"
        sub="UI, Public API und Webhook-Präfix sind verschiedene URLs — bei einem Reverse-Proxy können sie unterschiedliche öffentliche Pfade haben."
        badge={
          initial.connectionId ? (
            <span className="badge badge-green">Verbunden</span>
          ) : (
            <span className="badge badge-gray">Nicht verbunden</span>
          )
        }
        action={
          uiBaseUrl ? (
            <a
              className="btn-secondary inline-flex shrink-0 items-center gap-1.5 text-xs"
              href={uiBaseUrl}
              target="_blank"
              rel="noreferrer"
            >
              n8n öffnen <ExternalLink className="h-3 w-3" />
            </a>
          ) : undefined
        }
      >
        <N8nConnectionSection
          initial={initial}
          connection={connection}
          dispatchConnection={dispatchConnection}
          saveAction={saveAction}
          saving={saving}
          busy={busy}
          apiInstanceChanged={apiInstanceChanged}
          generateSecret={generateSecret}
          testApi={testApi}
          saveState={saveState}
          apiResult={apiResult}
          copied={copied}
          copy={copy}
        />
      </Stage>

      <Stage
        num={2}
        state={stageStates[1]!.state}
        title="Rückkanal n8n → TaxTronik"
        sub="Separates, tenantgebundenes Bearer-Credential mit minimalen Berechtigungen — nicht das Outbound-HMAC-Secret."
        badge={
          callbackConfigured ? (
            <span className="badge badge-green">Konfiguriert</span>
          ) : (
            <span className="badge badge-gray">Offen</span>
          )
        }
      >
        <N8nCallbackCredentialsSection
          initial={initial}
          callbackBaseUrl={callbackBaseUrl}
          callbackScopes={callbackScopes}
          setCallbackScopes={setCallbackScopes}
          callbackConfigured={callbackConfigured}
          callbackResult={callbackResult}
          setCallbackResult={setCallbackResult}
          rotateCallback={rotateCallback}
          busy={busy}
          saving={saving}
          copied={copied}
          copy={copy}
        />
      </Stage>

      <Stage
        num={3}
        state={stageStates[2]!.state}
        title="Workflows einrichten"
        sub="Vorlagen importieren oder eigene Webhooks erkennen — kein Workflow wird automatisch aktiviert oder überschrieben."
        badge={
          workflowsReady ? (
            <span className="badge badge-green">Eingerichtet</span>
          ) : (
            <span className="badge badge-gray">Offen</span>
          )
        }
      >
        <N8nWorkflowsSection
          initial={initial}
          bundledWorkflows={bundledWorkflows}
          selectedTemplates={selectedTemplates}
          setSelectedTemplates={setSelectedTemplates}
          n8nMailFrom={n8nMailFrom}
          setN8nMailFrom={setN8nMailFrom}
          gwgOfficerEmail={gwgOfficerEmail}
          setGwgOfficerEmail={setGwgOfficerEmail}
          workflows={workflows}
          workflowError={workflowError}
          discovered={discovered}
          discoveryError={discoveryError}
          importResult={importResult}
          importWorkflows={importWorkflows}
          loadWorkflows={loadWorkflows}
          discoverWebhooks={discoverWebhooks}
          selectDiscovered={selectDiscovered}
          selectedDiscoveredKey={selectedDiscoveredRouteKey(routeDraft)}
          selectedDiscoveredCanSave={discoveredRouteCanBeSaved(routeDraft)}
          saveSelectedDiscovered={persistRouteDraft}
          routeResult={routeResult}
          busy={busy}
          saving={saving}
        />
      </Stage>

      <Stage
        num={4}
        state={stageStates[3]!.state}
        title="Routen — Events an Workflows"
        sub="Ein Event darf mehrere Workflows beliefern; ein Workflow darf mehrere Events abonnieren."
        badge={
          verifiedActiveRoutes > 0 ? (
            <span className="badge badge-green">{verifiedActiveRoutes} aktiv</span>
          ) : (
            <span className="badge badge-gray">Keine aktive</span>
          )
        }
      >
        <RouteEditorSection
          endpoints={status.endpoints}
          connectionActive={isExplicitConnectionActive(connection)}
          events={events}
          routeDraft={routeDraft}
          setRouteDraft={setRouteDraft}
          customEvent={customEvent}
          setCustomEvent={setCustomEvent}
          routeResult={routeResult}
          testResult={testResult}
          busy={busy}
          saving={saving}
          onSaveRoute={saveRoute}
          onEditRoute={editRoute}
          onDeleteRoute={deleteRoute}
          onTestRoute={testRoute}
          onToggleRoute={toggleRoute}
        />
      </Stage>

      <Stage
        num={5}
        state={stageStates[4]!.state}
        title="Betrieb — Zustellung & Diagnose"
        sub="Jedes Event und jede Zielzustellung hat eine eigene ID — Fehler eines Workflows blockieren andere Abonnenten nicht."
        badge={
          status.deliveryCounts.failed > 0 ? (
            <span className="badge badge-red">{status.deliveryCounts.failed} fehlgeschlagen</span>
          ) : (
            <span className="badge badge-green">Ohne Befund</span>
          )
        }
      >
        <DeliveryOperationsSection
          status={status}
          failedDeliveries={failedDeliveries}
          failedCursor={failedCursor}
          hasMoreFailedDeliveries={hasMoreFailedDeliveries}
          deliveryOperationResult={deliveryOperationResult}
          retryResult={retryResult}
          replayResult={replayResult}
          busy={busy}
          saving={saving}
          onReplayUnroutedEvent={replayUnroutedEvent}
          onSkipUnroutedEvent={skipUnroutedEvent}
          onRetryDelivery={retryDelivery}
          onAcknowledgeDelivery={acknowledgeDelivery}
          onLoadMoreFailedDeliveries={loadMoreFailedDeliveries}
        />
      </Stage>
      <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-950 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200">
        <p className="font-medium">Eigene Workflows</p>
        <p className="mt-1">
          Webhook in n8n erstellen, Produktions-URL hier als Route speichern, Events auswählen und
          HMAC-Prüfung vor jede Verarbeitung setzen. Rückrufe nutzen den versionierten Callback mit
          Key-ID, Bearer-Token und eindeutiger Request-ID. Details stehen im Anwenderhandbuch
          „n8n-Automatisierungen“.
        </p>
        <a
          className="mt-2 inline-flex items-center gap-1 underline"
          href="https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/"
          target="_blank"
          rel="noreferrer"
        >
          n8n-Dokumentation zu Test- und Produktions-URLs <ExternalLink className="h-3 w-3" />
        </a>
      </div>

      {initial.connectionId && (
        <div className="danger-zone">
          <div>
            <div className="t">Integration deaktivieren und bereinigen</div>
            <div className="s">
              Entfernt Credentials und alle Routen. Zustellungen bleiben protokolliert.
            </div>
          </div>
          <button
            type="button"
            className="btn-danger-outline"
            onClick={resetConnection}
            disabled={busy || saving}
          >
            <Trash2 className="h-3.5 w-3.5" /> Deaktivieren
          </button>
        </div>
      )}
    </div>
  );
}
