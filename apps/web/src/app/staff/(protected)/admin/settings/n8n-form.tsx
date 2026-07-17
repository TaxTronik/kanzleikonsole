'use client';

import {
  Check,
  ChevronRight,
  Clipboard,
  Download,
  ExternalLink,
  KeyRound,
  Link2,
  Loader2,
  RefreshCw,
  Route,
  Save,
  Settings2,
  ShieldCheck,
  Trash2,
  Workflow,
} from 'lucide-react';
import { useActionState, useEffect, useReducer, useState, useTransition } from 'react';
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
import { createN8nConnectionState, n8nConnectionReducer } from './n8n-connection-state';
import { DeliveryOperationsSection } from './delivery-operations-section';
import { N8nActionResult } from './n8n-form-result';
import { EMPTY_ROUTE, RouteEditorSection, type RouteDraft } from './route-editor-section';
import { useConfirmedAction } from './use-confirmed-action';

export interface N8nBrowserConfig {
  connectionId: string | null;
  name: string;
  kind: 'BUNDLED' | 'SELF_HOSTED' | 'CLOUD';
  routingMode: 'DISABLED' | 'LEGACY' | 'EXPLICIT';
  enabled: boolean;
  uiBaseUrl: string;
  callbackBaseUrl: string;
  webhookBaseUrl: string;
  apiBaseUrl: string;
  hasSigningSecret: boolean;
  hasApiKey: boolean;
  callbackKeyId: string;
  callbackConfigured: boolean;
  callbackScopes: string[];
  healthCheckedAt: string | null;
  healthOk: boolean | null;
  healthError: string | null;
  source: 'CONNECTION' | 'LEGACY_SETTING' | 'ENV';
}

interface BundledWorkflowSummary {
  templateId: string;
  version: number;
  name: string;
  description: string;
  events: string[];
  callbackScopes: string[];
  credentials: Array<{ name: string; n8nType: string; source: string }>;
  prerequisites: string[];
}

interface Props {
  initial: N8nBrowserConfig;
  status: N8nSetupStatus;
  events: readonly N8nEventCatalogEntry[];
  bundledWorkflows: BundledWorkflowSummary[];
}

const CALLBACK_SCOPE_LABELS: Record<string, string> = {
  'requests:read': 'Anforderungen lesen',
  'gwg:read': 'GwG-Prüfungen lesen',
  'research:write': 'Research-Ergebnis zurückschreiben',
  'inbound-mail:write': 'Eingehende E-Mail zuordnen',
};

function urlOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
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

  const deliberatelyDisabled = Boolean(
    initial.connectionId && initial.routingMode === 'DISABLED' && !initial.enabled,
  );
  const verifiedActiveRoutes = status.endpoints.filter(
    (endpoint) => endpoint.enabled && endpoint.verificationOk === true,
  ).length;
  // Instanzwechsel nur, wenn tatsächlich eine API-URL gespeichert ist: mit
  // leerer gespeicherter URL (urlOrigin('') === '') zählte früher JEDE Eingabe
  // als Wechsel — Key-Eingabe und Test waren dann dauerhaft gesperrt.
  const initialApiOrigin = urlOrigin(initial.apiBaseUrl);
  const apiInstanceChanged = Boolean(
    initial.hasApiKey && initialApiOrigin !== '' && urlOrigin(apiBaseUrl) !== initialApiOrigin,
  );
  const setupSteps = [
    { label: 'Verbindung', done: Boolean(initial.connectionId) },
    {
      label: 'Credentials',
      done: deliberatelyDisabled || initial.hasSigningSecret || callbackConfigured,
    },
    { label: 'Workflow-Routen', done: deliberatelyDisabled || verifiedActiveRoutes > 0 },
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
    document.getElementById('n8n-route-editor')?.scrollIntoView({ behavior: 'smooth' });
  }

  function selectDiscovered(item: N8nDiscoveredWebhookView) {
    const matchingEvent = events.find((event) => event.name === item.path)?.name;
    const managed = bundledWorkflows.some((workflow) => workflow.name === item.workflowName);
    setRouteDraft({
      id: '',
      name: `${item.workflowName} — ${item.nodeName}`.slice(0, 120),
      productionUrl: item.productionUrl,
      testUrl: item.testUrl,
      workflowId: item.workflowId,
      workflowName: item.workflowName,
      workflowNodeId: item.nodeId,
      source: managed ? 'MANAGED' : 'DISCOVERED',
      enabled: item.workflowActive,
      testMode: false,
      events: matchingEvent ? [matchingEvent] : [],
    });
    setCustomEvent('');
    setRouteResult(null);
    document.getElementById('n8n-route-editor')?.scrollIntoView({ behavior: 'smooth' });
  }

  function saveRoute(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
        setRouteDraft(EMPTY_ROUTE);
        setCustomEvent('');
        router.refresh();
      }
    });
  }

  // Ein-Klick-Aktivierung/Deaktivierung direkt an der Routen-Karte: der
  // Server speichert neue Routen bewusst deaktiviert ("erst testen, dann
  // aktivieren") — ohne diesen Button ging Aktivieren nur über den Umweg
  // Bearbeiten → Häkchen → Speichern.
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
      if (result.ok) router.refresh();
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
    <div className="space-y-8">
      <div className="rounded-lg border border-default bg-surface-raised p-4">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {setupSteps.map((step, index) => (
            <div key={step.label} className="inline-flex items-center gap-2">
              <span
                className={
                  step.done
                    ? 'inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
                    : 'inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-1 font-medium text-muted dark:bg-gray-800'
                }
              >
                {step.done ? <Check className="h-3 w-3" /> : <span>{index + 1}</span>}
                {step.label}
              </span>
              {index < setupSteps.length - 1 && <ChevronRight className="h-3 w-3 text-disabled" />}
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted">
          {initial.source === 'ENV'
            ? 'Derzeit greift nur die Server-ENV. Speichern migriert die Verbindung in eine sichtbare Kanzlei-Konfiguration.'
            : initial.source === 'LEGACY_SETTING'
              ? 'Legacy-Konfiguration erkannt. Speichern Sie die Verbindung und ordnen Sie danach konkrete Workflow-Routen zu.'
              : 'TaxTronik kennt Verbindung, Credentials, exakte Workflow-Ziele und Zustellstatus dauerhaft.'}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatusCard
          label="Integration"
          value={initial.enabled ? 'Aktiv' : 'Deaktiviert'}
          tone={initial.enabled ? 'good' : 'neutral'}
        />
        <StatusCard
          label="Aktive Routen"
          value={String(status.activeEndpointCount)}
          tone={status.activeEndpointCount ? 'good' : 'neutral'}
        />
        <StatusCard label="Wartend" value={String(status.deliveryCounts.pending)} tone="neutral" />
        <StatusCard
          label="Fehlgeschlagen"
          value={String(status.deliveryCounts.failed)}
          tone={status.deliveryCounts.failed ? 'bad' : 'good'}
        />
        <StatusCard
          label="Ohne Route"
          value={String(status.deliveryCounts.unrouted)}
          tone={status.deliveryCounts.unrouted ? 'bad' : 'good'}
        />
      </div>

      <section className="space-y-4" aria-labelledby="n8n-connection-heading">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3
              id="n8n-connection-heading"
              className="inline-flex items-center gap-2 text-base font-semibold text-primary"
            >
              <Settings2 className="h-4 w-4" /> 1. n8n-Instanz verbinden
            </h3>
            <p className="mt-1 text-xs text-muted">
              UI, Public API und Webhook-Präfix sind verschiedene URLs. Bei einem Reverse-Proxy
              können sie unterschiedliche öffentliche Pfade haben.
            </p>
          </div>
          {uiBaseUrl && (
            <a
              className="btn-secondary inline-flex shrink-0 items-center gap-1.5 text-xs"
              href={uiBaseUrl}
              target="_blank"
              rel="noreferrer"
            >
              n8n öffnen <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>

        <form action={saveAction} className="rounded-lg border border-default p-4 space-y-4">
          {/* Text-/URL-/Secret-Felder tragen ihr name-Attribut DIREKT am
              sichtbaren Input (kein Hidden-Mirror): ein Submit vor bzw. ohne
              Hydration postete sonst die server-gerenderten Alt-Werte statt
              der Eingaben — "gespeichert", aber die getippten URLs waren weg
              und vorhandene Werte wurden genullt. Hidden bleiben nur die
              Zustände, die ausschließlich über hydrierte Custom-Controls
              änderbar sind (Routing-Modus, Keep-Flags) — deren SSR-Werte
              entsprechen dem gespeicherten Stand und sind damit safe. */}
          <input type="hidden" name="routingMode" value={routingMode} />
          {enabled && routingMode !== 'DISABLED' && (
            <input type="hidden" name="enabled" value="on" />
          )}
          {keepApiKey && <input type="hidden" name="keepApiKey" value="on" />}
          {keepHmac && <input type="hidden" name="keepHmac" value="on" />}

          <div className="grid gap-4 md:grid-cols-2">
            <label className="block">
              <span className="label">Bezeichnung</span>
              <input
                className="input"
                name="name"
                value={name}
                onChange={(event) =>
                  dispatchConnection({ type: 'patch', value: { name: event.target.value } })
                }
              />
            </label>
            <label className="block">
              <span className="label">Betriebsart</span>
              <select
                className="input"
                name="kind"
                value={kind}
                onChange={(event) =>
                  dispatchConnection({
                    type: 'patch',
                    value: { kind: event.target.value as typeof kind },
                  })
                }
              >
                <option value="BUNDLED">Mit TaxTronik Compose betrieben</option>
                <option value="SELF_HOSTED">Eigene n8n-Instanz</option>
                <option value="CLOUD">n8n Cloud</option>
              </select>
            </label>
          </div>

          <fieldset>
            <legend className="label">Routing</legend>
            <div className="grid gap-2 md:grid-cols-3">
              <ModeOption
                checked={routingMode === 'EXPLICIT'}
                onChange={() =>
                  dispatchConnection({
                    type: 'patch',
                    value: { routingMode: 'EXPLICIT', enabled: true },
                  })
                }
                title="Explizite Routen"
                description="Empfohlen: jedes Event kennt seine exakte Workflow-URL."
              />
              <ModeOption
                checked={routingMode === 'LEGACY'}
                onChange={() =>
                  dispatchConnection({
                    type: 'patch',
                    value: { routingMode: 'LEGACY', enabled: true },
                  })
                }
                title="Legacy-Präfix"
                description="Nur für Migration: hängt den Eventnamen an ein Präfix."
              />
              <ModeOption
                checked={routingMode === 'DISABLED'}
                onChange={() =>
                  dispatchConnection({
                    type: 'patch',
                    value: { routingMode: 'DISABLED', enabled: false },
                  })
                }
                title="Deaktiviert"
                description="Events werden nachvollziehbar übersprungen."
              />
            </div>
          </fieldset>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="block">
              <span className="label">n8n-Oberfläche</span>
              <input
                className="input"
                type="url"
                name="uiBaseUrl"
                value={uiBaseUrl}
                onChange={(event) =>
                  dispatchConnection({ type: 'patch', value: { uiBaseUrl: event.target.value } })
                }
                placeholder="https://n8n.example.de"
              />
              <span className="mt-1 block text-xs text-muted">
                Zum späteren Öffnen aus TaxTronik — nur die Basis-Adresse, ohne{' '}
                <code>/webhook</code>.
              </span>
            </label>
            <label className="block">
              <span className="label">Public API</span>
              <input
                className="input"
                type="url"
                name="apiBaseUrl"
                value={apiBaseUrl}
                onChange={(event) => {
                  const next = event.target.value;
                  // Nur ein ECHTER Origin-Wechsel gegenüber einer gespeicherten
                  // API-URL erzwingt einen neuen Key. Ist keine URL gespeichert
                  // (urlOrigin('') === ''), zählt die Eingabe nicht als
                  // Instanzwechsel — sonst war der Key nach jedem Speicherfehler
                  // dauerhaft gesperrt.
                  const initialOrigin = urlOrigin(initial.apiBaseUrl);
                  const changedInstance =
                    initial.hasApiKey && initialOrigin !== '' && urlOrigin(next) !== initialOrigin;
                  dispatchConnection({
                    type: 'patch',
                    value: changedInstance
                      ? { apiBaseUrl: next, keepApiKey: false }
                      : { apiBaseUrl: next, keepApiKey: initial.hasApiKey && !apiKey },
                  });
                }}
                placeholder="https://n8n.example.de/api/v1"
              />
              <span className="mt-1 block text-xs text-muted">
                Optional für Import und automatische Webhook-Erkennung.
              </span>
            </label>
            <label className="block">
              <span className="label">Produktions-Webhook-Präfix</span>
              <input
                className="input"
                type="url"
                name="webhookBaseUrl"
                value={webhookBaseUrl}
                onChange={(event) =>
                  dispatchConnection({
                    type: 'patch',
                    value: { webhookBaseUrl: event.target.value },
                  })
                }
                placeholder={
                  kind === 'BUNDLED' ? 'http://n8n:5678/webhook' : 'https://n8n.example.de/webhook'
                }
              />
              <span className="mt-1 block text-xs text-muted">
                Nur zur Erkennung bzw. im Legacy-Modus. Zugestellt wird bei explizitem Routing an
                die unten gespeicherten vollständigen URLs.
                {kind === 'BUNDLED' && (
                  <>
                    {' '}
                    Im Compose-Betrieb erreicht die App n8n direkt als{' '}
                    <code>http://n8n:5678/webhook</code> — localhost funktioniert aus dem
                    App-Container nicht.
                  </>
                )}
              </span>
            </label>
            <label className="block">
              <span className="label">TaxTronik-Adresse aus n8n</span>
              <input
                className="input"
                type="url"
                name="callbackBaseUrl"
                value={callbackBaseUrl}
                onChange={(event) =>
                  dispatchConnection({
                    type: 'patch',
                    value: { callbackBaseUrl: event.target.value },
                  })
                }
                placeholder={kind === 'BUNDLED' ? 'http://app:3000' : 'https://kanzlei.example.de'}
              />
              <span className="mt-1 block text-xs text-muted">
                Muss aus der n8n-Laufzeit erreichbar sein. Im TaxTronik-Compose-Netz ist das{' '}
                <code>http://app:3000</code>, extern die öffentliche TaxTronik-Adresse.
              </span>
            </label>
            <label className="block">
              <span className="label">n8n-API-Key (nur für Import/Erkennung)</span>
              <input
                className="input"
                type="password"
                name="apiKey"
                value={apiKey}
                onChange={(event) => {
                  const next = event.target.value;
                  // Feld geleert + Key gespeichert + Instanz unverändert →
                  // automatisch zurück auf "gespeicherten Key behalten" statt
                  // den Key beim nächsten Speichern stillschweigend zu leeren.
                  dispatchConnection({
                    type: 'patch',
                    value: next
                      ? { apiKey: next, keepApiKey: false }
                      : { apiKey: '', keepApiKey: initial.hasApiKey && !apiInstanceChanged },
                  });
                }}
                placeholder={
                  initial.hasApiKey && keepApiKey
                    ? '•••••••• gespeichert'
                    : 'API-Key aus n8n Settings'
                }
                autoComplete="new-password"
              />
              {initial.hasApiKey && !apiInstanceChanged && (
                <SecretKeep
                  checked={keepApiKey}
                  onChange={(value) =>
                    dispatchConnection({
                      type: 'patch',
                      value: value ? { keepApiKey: true, apiKey: '' } : { keepApiKey: false },
                    })
                  }
                  label="Gespeicherten API-Key beibehalten"
                />
              )}
              {apiInstanceChanged && !apiKey && (
                <span className="mt-1 block text-xs text-amber-700 dark:text-amber-300">
                  Die Public-API-Adresse zeigt auf eine andere n8n-Instanz — bitte den API-Key
                  dieser Instanz eingeben. Der gespeicherte Key wird aus Sicherheitsgründen nicht an
                  einen fremden Host gesendet.
                </span>
              )}
            </label>
          </div>

          <div className="rounded-md border border-default bg-surface-raised p-3">
            <div className="flex items-end gap-2">
              <label className="block flex-1">
                <span className="label">Outbound-Signatur-Secret (TaxTronik → n8n, HMAC)</span>
                <input
                  className="input"
                  type="password"
                  name="hmacSecret"
                  value={hmacSecret}
                  onChange={(event) => {
                    const next = event.target.value;
                    dispatchConnection({
                      type: 'patch',
                      value: next ? { hmacSecret: next, keepHmac: false } : { hmacSecret: next },
                    });
                  }}
                  placeholder={
                    initial.hasSigningSecret && keepHmac
                      ? '•••••••• gespeichert'
                      : 'mindestens 32 zufällige Zeichen'
                  }
                  autoComplete="new-password"
                />
              </label>
              <button
                type="button"
                className="btn-secondary mb-px text-xs"
                onClick={generateSecret}
                disabled={busy || saving}
              >
                Generieren
              </button>
            </div>
            {initial.hasSigningSecret && (
              <SecretKeep
                checked={keepHmac}
                onChange={(value) =>
                  dispatchConnection({
                    type: 'patch',
                    value: value ? { keepHmac: true, hmacSecret: '' } : { keepHmac: false },
                  })
                }
                label="Gespeichertes Signatur-Secret beibehalten"
              />
            )}
            {hmacSecret && !keepHmac && (
              <div className="mt-2 flex items-center justify-between gap-2 rounded bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                <span>
                  Jetzt in n8n als HMAC-Credential hinterlegen; nach dem Speichern zeigt TaxTronik
                  es nicht erneut.
                </span>
                <CopyButton label="HMAC" value={hmacSecret} copied={copied} onCopy={copy} />
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              className="btn-primary inline-flex items-center gap-1.5"
              disabled={saving || busy}
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Verbindung speichern
            </button>
            <button
              type="button"
              className="btn-secondary inline-flex items-center gap-1.5"
              onClick={testApi}
              disabled={busy || saving || !apiBaseUrl}
            >
              <Link2 className="h-4 w-4" /> API testen
            </button>
            <N8nActionResult result={saveState} />
            <N8nActionResult result={apiResult} />
          </div>
        </form>
      </section>

      <section className="space-y-4" aria-labelledby="n8n-credentials-heading">
        <div>
          <h3
            id="n8n-credentials-heading"
            className="inline-flex items-center gap-2 text-base font-semibold text-primary"
          >
            <KeyRound className="h-4 w-4" /> 2. Rückkanal n8n → TaxTronik
          </h3>
          <p className="mt-1 text-xs text-muted">
            Separates, tenantgebundenes Bearer-Credential mit minimalen Berechtigungen. Es ist nicht
            das Outbound-HMAC-Secret.
          </p>
        </div>
        <div className="rounded-lg border border-default p-4 space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <ReadOnlyValue
                label="Callback-Basis-URL"
                value={`${callbackBaseUrl.replace(/\/$/, '')}/api/integrations/n8n/v1`}
              />
              <span className="mt-1 block text-xs text-muted">
                Die Basis-URL antwortet auf GET als Verbindungstest (mit Credential: 200 + Scopes;
                ohne: 401 mit Anleitung). Die Fach-Endpunkte liegen auf Unterpfaden, z. B.{' '}
                <code>/research-result</code>.
              </span>
            </div>
            <ReadOnlyValue
              label="Key-ID"
              value={initial.callbackKeyId || 'Wird beim Speichern erzeugt'}
            />
          </div>
          <fieldset>
            <legend className="label">Berechtigungen des neuen Tokens</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {Object.entries(CALLBACK_SCOPE_LABELS).map(([scope, label]) => (
                <label key={scope} className="inline-flex items-center gap-2 text-xs text-primary">
                  <input
                    type="checkbox"
                    checked={callbackScopes.includes(scope)}
                    onChange={(event) =>
                      setCallbackScopes((current) =>
                        event.target.checked
                          ? [...current, scope]
                          : current.filter((item) => item !== scope),
                      )
                    }
                  />
                  {label} <code className="text-[10px] text-muted">{scope}</code>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="btn-secondary inline-flex items-center gap-1.5"
              onClick={rotateCallback}
              disabled={busy || saving || !initial.connectionId}
            >
              <RefreshCw className="h-4 w-4" />
              {callbackConfigured ? 'Callback-Token rotieren' : 'Callback-Token erzeugen'}
            </button>
            {callbackConfigured && (
              <span className="trend-up">
                <ShieldCheck className="h-4 w-4" /> Token eingerichtet
              </span>
            )}
            <N8nActionResult result={callbackResult} />
          </div>
          {callbackResult?.credential && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <p className="font-semibold">
                  Einmalige Anzeige — jetzt als n8n Header-Auth-Credential speichern. Die Anzeige
                  wird nach fünf Minuten aus dem Browser-State entfernt.
                </p>
                <button
                  type="button"
                  className="btn-secondary shrink-0 text-xs"
                  onClick={() => setCallbackResult(null)}
                >
                  Anzeige schließen
                </button>
              </div>
              <CredentialRow
                label="Callback-URL"
                value={callbackResult.credential.baseUrl}
                copied={copied}
                onCopy={copy}
              />
              <CredentialRow
                label="X-TaxTronik-Key-Id"
                value={callbackResult.credential.keyId}
                copied={copied}
                onCopy={copy}
              />
              <CredentialRow
                label="Authorization"
                value={`Bearer ${callbackResult.credential.token}`}
                copied={copied}
                onCopy={copy}
              />
              <p>
                Jeder Callback benötigt außerdem eine eindeutige <code>X-TaxTronik-Request-Id</code>
                .
              </p>
            </div>
          )}
        </div>
      </section>

      <section className="space-y-4" aria-labelledby="n8n-workflows-heading">
        <div>
          <h3
            id="n8n-workflows-heading"
            className="inline-flex items-center gap-2 text-base font-semibold text-primary"
          >
            <Workflow className="h-4 w-4" /> 3. Workflows einrichten
          </h3>
          <p className="mt-1 text-xs text-muted">
            Vorlagen werden nur importiert. TaxTronik aktiviert oder überschreibt keinen Workflow;
            Credentials und fachliche Wirkung müssen Sie in n8n prüfen.
          </p>
        </div>
        <div className="rounded-lg border border-default p-4 space-y-4">
          <div className="grid gap-3 lg:grid-cols-2">
            {bundledWorkflows.map((workflow) => (
              <div
                key={workflow.templateId}
                className="rounded-md border border-default bg-surface-raised p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-1"
                      aria-label={`${workflow.name} importieren`}
                      checked={selectedTemplates.includes(workflow.templateId)}
                      onChange={(event) =>
                        setSelectedTemplates((current) =>
                          event.target.checked
                            ? [...current, workflow.templateId]
                            : current.filter((id) => id !== workflow.templateId),
                        )
                      }
                    />
                    <div>
                      <p className="text-sm font-medium text-primary">{workflow.name}</p>
                      <p className="mt-1 text-xs text-muted">{workflow.description}</p>
                    </div>
                  </div>
                  <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-muted dark:bg-gray-800">
                    v{workflow.version}
                  </span>
                </div>
                {workflow.credentials.length > 0 && (
                  <div className="mt-2 space-y-1.5">
                    <p className="text-[11px] font-medium text-secondary">
                      In n8n anzulegende Credentials:
                    </p>
                    {workflow.credentials.map((credential) => (
                      <div
                        key={credential.name}
                        className="rounded border border-default bg-surface px-2 py-1.5 text-[11px]"
                      >
                        <p className="font-medium text-primary">
                          {credential.name}{' '}
                          <span className="font-normal text-muted">— {credential.n8nType}</span>
                        </p>
                        <p className="mt-0.5 text-muted">{credential.source}</p>
                      </div>
                    ))}
                  </div>
                )}
                <ul className="mt-2 list-disc pl-4 text-[11px] text-muted">
                  {workflow.prerequisites.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-muted">
            Hinweis: Der <code>N8N_ENCRYPTION_KEY</code> aus der Server-Konfiguration ist n8n-intern
            (verschlüsselt dort gespeicherte Credentials) und wird weder hier noch in Workflows
            eingetragen.
          </p>
          {(selectedTemplates.includes('taxtronik.request-reminder') ||
            selectedTemplates.includes('taxtronik.gwg-expiry-check')) && (
            <div className="grid gap-4 rounded-md border border-default p-3 md:grid-cols-2">
              <label className="block">
                <span className="label">Mail-Absender in n8n</span>
                <input
                  className="input"
                  value={n8nMailFrom}
                  onChange={(event) => setN8nMailFrom(event.target.value)}
                  placeholder="Kanzlei Muster <kanzlei@example.de>"
                />
                <span className="mt-1 block text-xs text-muted">
                  Leer lassen übernimmt – falls vorhanden – den TaxTronik-SMTP-Absender.
                </span>
              </label>
              {selectedTemplates.includes('taxtronik.gwg-expiry-check') && (
                <label className="block">
                  <span className="label">E-Mail GwG-Verantwortliche</span>
                  <input
                    className="input"
                    type="email"
                    value={gwgOfficerEmail}
                    onChange={(event) => setGwgOfficerEmail(event.target.value)}
                    placeholder="gwg@example.de"
                  />
                </label>
              )}
              <p className="text-xs text-muted md:col-span-2">
                Diese nicht geheimen Werte werden beim Import direkt in die Vorlage eingesetzt. API-
                und HMAC-Secrets bleiben ausschließlich n8n-Credentials.
              </p>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn-primary inline-flex items-center gap-1.5 text-xs"
              onClick={importWorkflows}
              disabled={busy || saving || !initial.hasApiKey || selectedTemplates.length === 0}
            >
              <Download className="h-3.5 w-3.5" /> Fehlende Vorlagen importieren
            </button>
            <button
              type="button"
              className="btn-secondary inline-flex items-center gap-1.5 text-xs"
              onClick={loadWorkflows}
              disabled={busy || saving || !initial.hasApiKey}
            >
              <RefreshCw className="h-3.5 w-3.5" /> Workflow-Status laden
            </button>
            <button
              type="button"
              className="btn-secondary inline-flex items-center gap-1.5 text-xs"
              onClick={discoverWebhooks}
              disabled={busy || saving || !initial.hasApiKey}
            >
              <Route className="h-3.5 w-3.5" /> Webhook-Knoten erkennen
            </button>
            {busy && <Loader2 className="h-4 w-4 animate-spin text-muted" />}
          </div>
          <N8nActionResult result={importResult} />
          {workflowError && (
            <p className="text-xs text-red-700 dark:text-red-400">{workflowError}</p>
          )}
          {discoveryError && (
            <p className="text-xs text-red-700 dark:text-red-400">{discoveryError}</p>
          )}
          {workflows && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-muted">
                  <tr>
                    <th className="py-2 pr-3">Workflow</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2">Geändert</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {workflows.map((workflow) => (
                    <tr key={workflow.id}>
                      <td className="py-2 pr-3 text-primary">{workflow.name}</td>
                      <td className="py-2 pr-3">
                        {workflow.active ? (
                          <span className="trend-up">veröffentlicht</span>
                        ) : (
                          <span className="text-muted">inaktiv</span>
                        )}
                      </td>
                      <td className="py-2 text-muted">
                        {fmtDateTimeShort(new Date(workflow.updatedAt))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {discovered && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-primary">Erkannte POST-Webhooks</p>
              {discovered.length === 0 ? (
                <p className="text-xs text-muted">Keine POST-Webhook-Knoten gefunden.</p>
              ) : (
                discovered.map((item) => (
                  <div
                    key={`${item.workflowId}:${item.nodeName}:${item.path}`}
                    className="flex flex-wrap items-center justify-between gap-3 rounded border border-default px-3 py-2 text-xs"
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-primary">
                        {item.workflowName} · {item.nodeName}
                      </p>
                      <p className="truncate font-mono text-[10px] text-muted">
                        {item.productionUrl || `Pfad: ${item.path} — Webhook-Präfix fehlt`}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="btn-secondary text-xs"
                      onClick={() => selectDiscovered(item)}
                    >
                      Als Route übernehmen
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </section>

      <RouteEditorSection
        endpoints={status.endpoints}
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
        <div className="border-t border-default pt-4">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-red-700"
            onClick={resetConnection}
            disabled={busy || saving}
          >
            <Trash2 className="h-3.5 w-3.5" /> Deaktivieren und Credentials/Routen bereinigen
          </button>
        </div>
      )}
    </div>
  );
}

function StatusCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'good' | 'bad' | 'neutral';
}) {
  return (
    <div className="rounded-lg border border-default bg-surface-raised p-3">
      <p className="text-[10px] uppercase tracking-wide text-muted">{label}</p>
      <p
        className={
          tone === 'good'
            ? 'mt-1 text-lg font-semibold text-emerald-700 dark:text-emerald-400'
            : tone === 'bad'
              ? 'mt-1 text-lg font-semibold text-red-700 dark:text-red-400'
              : 'mt-1 text-lg font-semibold text-primary'
        }
      >
        {value}
      </p>
    </div>
  );
}

function ModeOption({
  checked,
  onChange,
  title,
  description,
}: {
  checked: boolean;
  onChange: () => void;
  title: string;
  description: string;
}) {
  return (
    <label
      className={
        checked
          ? 'cursor-pointer rounded-md border border-blue-500 bg-blue-50 p-3 dark:bg-blue-950/30'
          : 'cursor-pointer rounded-md border border-default p-3'
      }
    >
      <span className="flex items-center gap-2 text-sm font-medium text-primary">
        <input type="radio" checked={checked} onChange={onChange} /> {title}
      </span>
      <span className="mt-1 block pl-5 text-xs text-muted">{description}</span>
    </label>
  );
}

function SecretKeep({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <label className="mt-1 inline-flex items-center gap-2 text-xs text-muted">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />{' '}
      {label}
    </label>
  );
}

function ReadOnlyValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="label">{label}</p>
      <code className="block break-all rounded bg-surface-raised px-3 py-2 text-xs text-primary">
        {value}
      </code>
    </div>
  );
}

function CopyButton({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: string | null;
  onCopy: (label: string, value: string) => void;
}) {
  return (
    <button
      type="button"
      className="btn-secondary inline-flex shrink-0 items-center gap-1 text-xs"
      onClick={() => onCopy(label, value)}
    >
      {copied === label ? <Check className="h-3 w-3" /> : <Clipboard className="h-3 w-3" />}{' '}
      {copied === label ? 'Kopiert' : 'Kopieren'}
    </button>
  );
}

function CredentialRow({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: string | null;
  onCopy: (label: string, value: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-32 shrink-0 font-medium">{label}</span>
      <code className="min-w-0 flex-1 break-all rounded bg-white/70 px-2 py-1 dark:bg-black/20">
        {value}
      </code>
      <CopyButton label={label} value={value} copied={copied} onCopy={onCopy} />
    </div>
  );
}
