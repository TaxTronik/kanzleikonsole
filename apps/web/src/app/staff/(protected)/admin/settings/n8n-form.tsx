'use client';

import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronRight,
  Clipboard,
  Download,
  ExternalLink,
  KeyRound,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Route,
  Save,
  Send,
  Settings2,
  ShieldCheck,
  Trash2,
  Workflow,
  XCircle,
} from 'lucide-react';
import { useActionState, useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { requiresSeparateTestWebhook, type N8nEventCatalogEntry } from '@taxtronik/n8n-shared';
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
  prerequisites: string[];
}

interface Props {
  initial: N8nBrowserConfig;
  status: N8nSetupStatus;
  events: readonly N8nEventCatalogEntry[];
  bundledWorkflows: BundledWorkflowSummary[];
}

interface RouteDraft {
  id: string;
  name: string;
  productionUrl: string;
  testUrl: string;
  workflowId: string;
  workflowName: string;
  workflowNodeId: string;
  source: 'MANAGED' | 'DISCOVERED' | 'CUSTOM';
  enabled: boolean;
  events: string[];
}

const EMPTY_ROUTE: RouteDraft = {
  id: '',
  name: '',
  productionUrl: '',
  testUrl: '',
  workflowId: '',
  workflowName: '',
  workflowNodeId: '',
  source: 'CUSTOM',
  enabled: false,
  events: [],
};

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
  const [name, setName] = useState(initial.name);
  const [kind, setKind] = useState(initial.kind);
  const [routingMode, setRoutingMode] = useState(initial.routingMode);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [uiBaseUrl, setUiBaseUrl] = useState(initial.uiBaseUrl);
  const [callbackBaseUrl, setCallbackBaseUrl] = useState(initial.callbackBaseUrl);
  const [webhookBaseUrl, setWebhookBaseUrl] = useState(initial.webhookBaseUrl);
  const [apiBaseUrl, setApiBaseUrl] = useState(initial.apiBaseUrl);
  const [apiKey, setApiKey] = useState('');
  const [keepApiKey, setKeepApiKey] = useState(initial.hasApiKey);
  const [hmacSecret, setHmacSecret] = useState('');
  const [keepHmac, setKeepHmac] = useState(initial.hasSigningSecret);
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
      setHmacSecret('');
      setApiKey('');
      setKeepHmac(true);
      setKeepApiKey(true);
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

  const groupedEvents = useMemo(() => {
    const groups = new Map<string, N8nEventCatalogEntry[]>();
    for (const event of events) {
      const list = groups.get(event.categoryLabel) ?? [];
      list.push(event);
      groups.set(event.categoryLabel, list);
    }
    return [...groups.entries()];
  }, [events]);
  const staticEventNames = useMemo(
    () => new Set<string>(events.map((event) => event.name)),
    [events],
  );
  const customRouteEvents = routeDraft.events.filter((event) => !staticEventNames.has(event));
  const routeRequiresTestUrl =
    requiresSeparateTestWebhook(routeDraft.events) || Boolean(customEvent.trim());
  const visibleDeliveries = useMemo(() => {
    const seen = new Set<string>();
    return [...failedDeliveries, ...status.recentDeliveries].filter((delivery) => {
      if (seen.has(delivery.id)) return false;
      seen.add(delivery.id);
      return true;
    });
  }, [failedDeliveries, status.recentDeliveries]);

  const deliberatelyDisabled = Boolean(
    initial.connectionId && initial.routingMode === 'DISABLED' && !initial.enabled,
  );
  const verifiedActiveRoutes = status.endpoints.filter(
    (endpoint) => endpoint.enabled && endpoint.verificationOk === true,
  ).length;
  const apiInstanceChanged = Boolean(
    initial.hasApiKey && urlOrigin(apiBaseUrl) !== urlOrigin(initial.apiBaseUrl),
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
        setHmacSecret(result.secret);
        setKeepHmac(false);
      }
    });
  }

  function rotateCallback() {
    if (
      callbackConfigured &&
      !confirm('Das bisherige Callback-Token wird sofort ungültig. Wirklich rotieren?')
    ) {
      return;
    }
    setCallbackResult(null);
    startTransition(async () => {
      const result = await rotateN8nCallbackCredentialAction(callbackScopes);
      setCallbackResult(result);
      if (result.ok) {
        setCallbackConfigured(true);
        router.refresh();
      }
    });
  }

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
        if (key === 'events' || key === 'enabled') continue;
        data.set(key, String(value));
      }
      if (routeDraft.enabled) data.set('enabled', 'on');
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

  function deleteRoute(endpointId: string) {
    if (!confirm('Diese Route und ihre Event-Abonnements entfernen?')) return;
    startTransition(async () => {
      const result = await deleteN8nEndpointAction(endpointId);
      if (!result.ok) setRouteResult(result);
      router.refresh();
    });
  }

  function testRoute(endpointId: string, useTestUrl: boolean, eventName: string) {
    const key = `${endpointId}:${useTestUrl ? 'test' : 'prod'}:${eventName}`;
    setTestResult((current) => ({ ...current, [key]: { ok: true, message: 'Prüfung läuft…' } }));
    startTransition(async () => {
      const result = await testN8nEndpointAction(endpointId, useTestUrl, eventName);
      setTestResult((current) => ({ ...current, [key]: result }));
      router.refresh();
    });
  }

  function retryDelivery(deliveryId: string, targetUrl: string) {
    if (!confirm(`Zustellung erneut an dieses unveränderte Ziel senden?\n\n${targetUrl}`)) return;
    setRetryResult((current) => ({
      ...current,
      [deliveryId]: { ok: true, message: 'Wird eingeplant…' },
    }));
    startTransition(async () => {
      const result = await retryN8nDeliveryAction(deliveryId);
      setRetryResult((current) => ({ ...current, [deliveryId]: result }));
      router.refresh();
    });
  }

  function acknowledgeDelivery(deliveryId: string) {
    if (
      !confirm(
        'Diesen Fehler ohne erneuten Versand administrativ abschließen? Die Zustellung wird als übersprungen markiert und die Entscheidung revisionsprotokolliert.',
      )
    ) {
      return;
    }
    setDeliveryOperationResult({ ok: true, message: 'Fehler wird quittiert…' });
    startTransition(async () => {
      const result = await acknowledgeN8nDeliveryAction(deliveryId);
      setDeliveryOperationResult(result);
      router.refresh();
    });
  }

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

  function replayUnroutedEvent(eventId: string, eventName: string, occurredAt: string) {
    if (
      !confirm(
        `Das gespeicherte Event „${eventName}“ vom ${fmtDateTimeShort(new Date(occurredAt))} enthält möglicherweise vertrauliche Daten. Jetzt an die aktuell konfigurierten Ziele senden?`,
      )
    ) {
      return;
    }
    setReplayResult((current) => ({
      ...current,
      [eventId]: { ok: true, message: 'Wird den aktuellen Routen zugeordnet…' },
    }));
    startTransition(async () => {
      const result = await replayUnroutedN8nEventAction(eventId);
      setReplayResult((current) => ({ ...current, [eventId]: result }));
      router.refresh();
    });
  }

  function skipUnroutedEvent(eventId: string, eventName: string) {
    if (
      !confirm(
        `Event „${eventName}“ dauerhaft ohne n8n-Versand abschließen? Diese Entscheidung wird protokolliert.`,
      )
    ) {
      return;
    }
    setReplayResult((current) => ({
      ...current,
      [eventId]: { ok: true, message: 'Wird abgeschlossen…' },
    }));
    startTransition(async () => {
      const result = await skipUnroutedN8nEventAction(eventId);
      setReplayResult((current) => ({ ...current, [eventId]: result }));
      router.refresh();
    });
  }

  async function copy(label: string, value: string) {
    await navigator.clipboard.writeText(value);
    setCopied(label);
    window.setTimeout(() => setCopied(null), 1_500);
  }

  function resetConnection() {
    if (!confirm('n8n deaktivieren und alle Credentials sowie Routen entfernen?')) return;
    startTransition(async () => {
      await resetN8nAction();
      window.location.reload();
    });
  }

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
          <input type="hidden" name="name" value={name} />
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="routingMode" value={routingMode} />
          <input type="hidden" name="uiBaseUrl" value={uiBaseUrl} />
          <input type="hidden" name="callbackBaseUrl" value={callbackBaseUrl} />
          <input type="hidden" name="webhookBaseUrl" value={webhookBaseUrl} />
          <input type="hidden" name="apiBaseUrl" value={apiBaseUrl} />
          <input type="hidden" name="apiKey" value={apiKey} />
          <input type="hidden" name="hmacSecret" value={hmacSecret} />
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
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="block">
              <span className="label">Betriebsart</span>
              <select
                className="input"
                value={kind}
                onChange={(event) => setKind(event.target.value as typeof kind)}
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
                onChange={() => {
                  setRoutingMode('EXPLICIT');
                  setEnabled(true);
                }}
                title="Explizite Routen"
                description="Empfohlen: jedes Event kennt seine exakte Workflow-URL."
              />
              <ModeOption
                checked={routingMode === 'LEGACY'}
                onChange={() => {
                  setRoutingMode('LEGACY');
                  setEnabled(true);
                }}
                title="Legacy-Präfix"
                description="Nur für Migration: hängt den Eventnamen an ein Präfix."
              />
              <ModeOption
                checked={routingMode === 'DISABLED'}
                onChange={() => {
                  setRoutingMode('DISABLED');
                  setEnabled(false);
                }}
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
                value={uiBaseUrl}
                onChange={(event) => setUiBaseUrl(event.target.value)}
                placeholder="https://n8n.example.de"
              />
              <span className="mt-1 block text-xs text-muted">
                Zum späteren Öffnen aus TaxTronik.
              </span>
            </label>
            <label className="block">
              <span className="label">Public API</span>
              <input
                className="input"
                type="url"
                value={apiBaseUrl}
                onChange={(event) => {
                  const next = event.target.value;
                  setApiBaseUrl(next);
                  if (initial.hasApiKey && urlOrigin(next) !== urlOrigin(initial.apiBaseUrl)) {
                    setKeepApiKey(false);
                  }
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
                value={webhookBaseUrl}
                onChange={(event) => setWebhookBaseUrl(event.target.value)}
                placeholder="https://n8n.example.de/webhook"
              />
              <span className="mt-1 block text-xs text-muted">
                Nur zur Erkennung bzw. im Legacy-Modus. Zugestellt wird bei explizitem Routing an
                die unten gespeicherten vollständigen URLs.
              </span>
            </label>
            <label className="block">
              <span className="label">TaxTronik-Adresse aus n8n</span>
              <input
                className="input"
                type="url"
                value={callbackBaseUrl}
                onChange={(event) => setCallbackBaseUrl(event.target.value)}
                placeholder={kind === 'BUNDLED' ? 'http://app:3000' : 'https://kanzlei.example.de'}
              />
              <span className="mt-1 block text-xs text-muted">
                Muss aus der n8n-Laufzeit erreichbar sein. Im TaxTronik-Compose-Netz ist das{' '}
                <code>http://app:3000</code>, extern die öffentliche TaxTronik-Adresse.
              </span>
            </label>
            <label className="block">
              <span className="label">n8n-API-Key</span>
              <input
                className="input"
                type="password"
                value={apiKey}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  if (event.target.value) setKeepApiKey(false);
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
                  onChange={(value) => {
                    setKeepApiKey(value);
                    if (value) setApiKey('');
                  }}
                  label="Gespeicherten API-Key beibehalten"
                />
              )}
              {apiInstanceChanged && !apiKey && (
                <span className="mt-1 block text-xs text-amber-700 dark:text-amber-300">
                  Für die geänderte API-Instanz muss ein neuer Key eingegeben werden.
                </span>
              )}
            </label>
          </div>

          <div className="rounded-md border border-default bg-surface-raised p-3">
            <div className="flex items-end gap-2">
              <label className="block flex-1">
                <span className="label">Outbound-Signatur-Secret (TaxTronik → n8n)</span>
                <input
                  className="input"
                  type="password"
                  value={hmacSecret}
                  onChange={(event) => {
                    setHmacSecret(event.target.value);
                    if (event.target.value) setKeepHmac(false);
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
                onChange={(value) => {
                  setKeepHmac(value);
                  if (value) setHmacSecret('');
                }}
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
            <Result result={saveState} />
            <Result result={apiResult} />
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
            <ReadOnlyValue
              label="Callback-Basis-URL"
              value={`${callbackBaseUrl.replace(/\/$/, '')}/api/integrations/n8n/v1`}
            />
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
            <Result result={callbackResult} />
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
                <ul className="mt-2 list-disc pl-4 text-[11px] text-muted">
                  {workflow.prerequisites.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
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
          <Result result={importResult} />
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

      <section className="space-y-4" aria-labelledby="n8n-routes-heading">
        <div>
          <h3
            id="n8n-routes-heading"
            className="inline-flex items-center gap-2 text-base font-semibold text-primary"
          >
            <Route className="h-4 w-4" /> 4. Event-Routen
          </h3>
          <p className="mt-1 text-xs text-muted">
            Ein Event darf mehrere Workflows beliefern; ein Workflow darf mehrere Events abonnieren.
            Speichern Sie immer die exakte Produktions-URL aus dem jeweiligen n8n-Webhook-Knoten.
          </p>
        </div>

        <div className="space-y-2">
          {status.endpoints.length === 0 && (
            <div className="rounded-md border border-dashed border-default p-4 text-xs text-muted">
              Noch keine explizite Workflow-Route.
            </div>
          )}
          {status.endpoints.map((endpoint) => (
            <div key={endpoint.id} className="rounded-lg border border-default p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium text-primary">{endpoint.name}</p>
                    <RouteState endpoint={endpoint} />
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-muted dark:bg-gray-800">
                      {endpoint.source.toLowerCase()}
                    </span>
                  </div>
                  <p
                    className="mt-1 truncate font-mono text-[10px] text-muted"
                    title={endpoint.productionUrl}
                  >
                    {endpoint.productionUrl}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {endpoint.events.map((event) => (
                      <code
                        key={event}
                        className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-800 dark:bg-blue-950/40 dark:text-blue-300"
                      >
                        {event}
                      </code>
                    ))}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {endpoint.events.includes('taxtronik.ping') && (
                    <button
                      type="button"
                      className="btn-secondary inline-flex items-center gap-1 text-xs"
                      onClick={() => testRoute(endpoint.id, false, 'taxtronik.ping')}
                      disabled={busy || saving}
                    >
                      <Send className="h-3 w-3" /> Produktion testen
                    </button>
                  )}
                  {endpoint.testUrl &&
                    endpoint.events.map((eventName) => (
                      <button
                        key={eventName}
                        type="button"
                        className="btn-secondary text-xs"
                        onClick={() => testRoute(endpoint.id, true, eventName)}
                        disabled={busy || saving}
                      >
                        Test: {eventName}
                      </button>
                    ))}
                  <button
                    type="button"
                    className="btn-secondary text-xs"
                    onClick={() => editRoute(endpoint)}
                    disabled={busy || saving}
                  >
                    Bearbeiten
                  </button>
                  <button
                    type="button"
                    className="btn-secondary p-2 text-red-700"
                    aria-label="Route löschen"
                    onClick={() => deleteRoute(endpoint.id)}
                    disabled={busy || saving}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              {endpoint.events.map((eventName) => (
                <div key={eventName}>
                  <Result result={testResult[`${endpoint.id}:prod:${eventName}`]} />
                  <Result result={testResult[`${endpoint.id}:test:${eventName}`]} />
                </div>
              ))}
            </div>
          ))}
        </div>

        <form
          id="n8n-route-editor"
          onSubmit={saveRoute}
          className="rounded-lg border border-default bg-surface-raised p-4 space-y-4"
        >
          <div className="flex items-center justify-between gap-2">
            <p className="inline-flex items-center gap-2 text-sm font-semibold text-primary">
              <Plus className="h-4 w-4" />{' '}
              {routeDraft.id ? 'Route bearbeiten' : 'Eigene Workflow-Route hinzufügen'}
            </p>
            {routeDraft.id && (
              <button
                type="button"
                className="text-xs text-muted"
                onClick={() => {
                  setRouteDraft(EMPTY_ROUTE);
                  setCustomEvent('');
                }}
              >
                Abbrechen
              </button>
            )}
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block">
              <span className="label">Name</span>
              <input
                className="input"
                required
                value={routeDraft.name}
                onChange={(event) =>
                  setRouteDraft((current) => ({ ...current, name: event.target.value }))
                }
                placeholder="Mein n8n-Workflow"
              />
            </label>
            <label className="inline-flex items-center gap-2 self-end pb-2 text-xs text-primary">
              <input
                type="checkbox"
                checked={routeDraft.enabled}
                onChange={(event) =>
                  setRouteDraft((current) => ({ ...current, enabled: event.target.checked }))
                }
              />{' '}
              Route aktiv
            </label>
            <label className="block md:col-span-2">
              <span className="label">Exakte Produktions-URL</span>
              <input
                className="input"
                required
                type="url"
                value={routeDraft.productionUrl}
                onChange={(event) =>
                  setRouteDraft((current) => ({ ...current, productionUrl: event.target.value }))
                }
                placeholder="https://n8n.example.de/webhook/der-pfad-dieses-workflows"
              />
            </label>
            <label className="block md:col-span-2">
              <span className="label">
                Separate Test-URL{' '}
                {routeRequiresTestUrl ? '(erforderlich)' : '(optional für reinen Verbindungstest)'}
              </span>
              <input
                className="input"
                type="url"
                required={routeRequiresTestUrl}
                value={routeDraft.testUrl}
                onChange={(event) =>
                  setRouteDraft((current) => ({ ...current, testUrl: event.target.value }))
                }
                placeholder="https://n8n.example.de/webhook-test/der-pfad-dieses-workflows"
              />
              <span className="mt-1 block text-xs text-muted">
                Die URL muss <code>/webhook-test/</code> enthalten und funktioniert nur, während der
                Workflow in n8n auf ein Testereignis wartet. Für Fach-Events ist sie Pflicht, weil
                TaxTronik synthetische Fachdaten nie an Produktion sendet. Sie wird nie für echte
                Zustellungen genutzt.
              </span>
            </label>
          </div>

          <fieldset>
            <legend className="label">TaxTronik-Events</legend>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {groupedEvents.map(([category, categoryEvents]) => (
                <div key={category} className="rounded border border-default p-2">
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
                    {category}
                  </p>
                  {categoryEvents.map((event) => (
                    <div
                      key={event.name}
                      className="border-t border-default/60 py-1 first:border-0"
                    >
                      <label
                        className="flex items-start gap-2 text-xs text-primary"
                        title={event.piiNotice}
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={routeDraft.events.includes(event.name)}
                          onChange={(input) =>
                            setRouteDraft((current) => ({
                              ...current,
                              events: input.target.checked
                                ? [...current.events, event.name]
                                : current.events.filter((name) => name !== event.name),
                            }))
                          }
                        />
                        <span>
                          <span className="block">{event.label}</span>
                          <code className="text-[10px] text-muted">{event.name}</code>
                        </span>
                      </label>
                      <details className="ml-6 mt-1 text-[10px] text-muted">
                        <summary className="cursor-pointer">
                          Payload-Beispiel und Datenschutz
                        </summary>
                        <p className="mt-1">{event.description}</p>
                        <pre className="mt-1 max-h-44 overflow-auto rounded bg-surface px-2 py-1 text-[10px] text-primary">
                          {JSON.stringify(event.examplePayload, null, 2)}
                        </pre>
                        <p className="mt-1">{event.piiNotice}</p>
                      </details>
                    </div>
                  ))}
                </div>
              ))}
            </div>
            {customRouteEvents.length > 0 && (
              <div className="mt-3">
                <span className="label">Gespeicherte Workflow-Schritt-Events</span>
                <div className="flex flex-wrap gap-2">
                  {customRouteEvents.map((eventName) => (
                    <span
                      key={eventName}
                      className="inline-flex items-center gap-1 rounded border border-default px-2 py-1 text-xs"
                    >
                      <code>{eventName}</code>
                      <button
                        type="button"
                        className="text-muted hover:text-danger"
                        aria-label={`${eventName} entfernen`}
                        onClick={() =>
                          setRouteDraft((current) => ({
                            ...current,
                            events: current.events.filter((name) => name !== eventName),
                          }))
                        }
                      >
                        <XCircle className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}
            <label className="mt-3 block">
              <span className="label">Weiteres Workflow-Schritt-Event (optional)</span>
              <input
                className="input"
                value={customEvent}
                onChange={(event) => setCustomEvent(event.target.value)}
                placeholder="workflow.step.mein_schritt"
                pattern="workflow\.step\.[a-z][a-z0-9_-]{0,40}"
              />
            </label>
          </fieldset>

          {(events.some(
            (event) => routeDraft.events.includes(event.name) && event.containsPersonalData,
          ) ||
            customRouteEvents.length > 0 ||
            Boolean(customEvent.trim())) && (
            <p className="rounded bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
              Diese Auswahl kann personenbezogene Daten bzw. Berufsgeheimnisse betreffen. Im eigenen
              n8n-Workflow nur erforderliche Daten verarbeiten und Ausführungsdaten begrenzen.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              className="btn-primary inline-flex items-center gap-1.5"
              disabled={busy || saving}
            >
              <Save className="h-4 w-4" /> Route speichern
            </button>
            <Result result={routeResult} />
          </div>
        </form>
      </section>

      <section className="space-y-4" aria-labelledby="n8n-operation-heading">
        <div>
          <h3
            id="n8n-operation-heading"
            className="inline-flex items-center gap-2 text-base font-semibold text-primary"
          >
            <ShieldCheck className="h-4 w-4" /> 5. Zustellung & Betrieb
          </h3>
          <p className="mt-1 text-xs text-muted">
            Jedes Event und jede Zielzustellung hat eine eigene ID. Fehler eines Workflows
            blockieren andere Abonnenten nicht.
          </p>
        </div>
        {status.deliveryCounts.failed > 0 && (
          <div className="rounded-md border border-red-300 bg-red-50 p-3 text-xs text-red-950 dark:border-red-900 dark:bg-red-950/30 dark:text-red-100">
            <p className="font-semibold">
              {status.deliveryCounts.failed} offene fehlgeschlagene Zustellung(en)
            </p>
            <p className="mt-1">
              Offene Fehler stehen immer zuerst in der Tabelle und können seitenweise vollständig
              geladen werden. Ist das gespeicherte Ziel noch aktuell, kann erneut zugestellt werden;
              veraltete oder bewusst verworfene Fehler lassen sich ohne Versand
              revisionsprotokolliert quittieren.
            </p>
          </div>
        )}
        <Result result={deliveryOperationResult} />
        {status.unroutedEvents.length > 0 && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
            <p className="font-semibold">Events ohne aktive Route</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {status.unroutedEvents.map((item) => (
                <code key={item.event} className="rounded bg-white/70 px-2 py-1 dark:bg-black/20">
                  {item.event} ({item.count})
                </code>
              ))}
            </div>
            <div className="mt-3 space-y-2">
              {status.recentUnroutedEvents.map((item) => (
                <div
                  key={item.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-200 bg-white/60 px-2 py-1.5 dark:border-amber-900 dark:bg-black/20"
                >
                  <span>
                    <code>{item.event}</code>{' '}
                    <span className="text-amber-800 dark:text-amber-200">
                      {fmtDateTimeShort(new Date(item.occurredAt))}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className="btn-secondary text-xs"
                      disabled={busy || saving}
                      onClick={() => replayUnroutedEvent(item.id, item.event, item.occurredAt)}
                    >
                      Jetzt zuordnen
                    </button>
                    <button
                      type="button"
                      className="btn-secondary text-xs"
                      disabled={busy || saving}
                      onClick={() => skipUnroutedEvent(item.id, item.event)}
                    >
                      Nicht senden
                    </button>
                    <Result result={replayResult[item.id]} />
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="overflow-x-auto rounded-lg border border-default">
          <table className="w-full min-w-[760px] text-left text-xs">
            <thead className="bg-surface-raised text-muted">
              <tr>
                <th className="px-3 py-2">Zeit</th>
                <th className="px-3 py-2">Event</th>
                <th className="px-3 py-2">Workflow</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Versuche</th>
                <th className="px-3 py-2">Diagnose</th>
                <th className="px-3 py-2">Aktion</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {visibleDeliveries.map((delivery) => (
                <tr key={delivery.id}>
                  <td className="px-3 py-2 text-muted">
                    {fmtDateTimeShort(new Date(delivery.createdAt))}
                  </td>
                  <td className="px-3 py-2">
                    <code title={`Event-ID ${delivery.eventId}\nDelivery-ID ${delivery.id}`}>
                      {delivery.event}
                    </code>
                  </td>
                  <td className="px-3 py-2 text-primary">
                    <span className="block">{delivery.endpoint}</span>
                    <code
                      className="block max-w-[260px] truncate text-[10px] text-muted"
                      title={delivery.targetUrl}
                    >
                      {delivery.targetUrl || 'kein HTTP-Ziel'}
                    </code>
                  </td>
                  <td className="px-3 py-2">
                    <DeliveryState status={delivery.status} />
                  </td>
                  <td className="px-3 py-2 text-muted">{delivery.attempts}</td>
                  <td
                    className="max-w-[280px] truncate px-3 py-2 text-muted"
                    title={delivery.lastError ?? undefined}
                  >
                    {delivery.httpStatus
                      ? `HTTP ${delivery.httpStatus}`
                      : (delivery.lastError ??
                        (delivery.latencyMs != null ? `${delivery.latencyMs} ms` : '—'))}
                  </td>
                  <td className="px-3 py-2">
                    {delivery.status === 'FAILED' && (
                      <span className="flex flex-wrap gap-1">
                        <button
                          type="button"
                          className="btn-secondary text-xs"
                          disabled={busy || saving || !delivery.targetUrl}
                          onClick={() => retryDelivery(delivery.id, delivery.targetUrl)}
                        >
                          Erneut versuchen
                        </button>
                        <button
                          type="button"
                          className="btn-secondary text-xs"
                          disabled={busy || saving}
                          onClick={() => acknowledgeDelivery(delivery.id)}
                        >
                          Quittieren
                        </button>
                      </span>
                    )}
                    <Result result={retryResult[delivery.id]} />
                  </td>
                </tr>
              ))}
              {visibleDeliveries.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-muted">
                    Noch keine Zustellungen.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {hasMoreFailedDeliveries && (
          <button
            type="button"
            className="btn-secondary text-xs"
            disabled={busy || saving || !failedCursor}
            onClick={loadMoreFailedDeliveries}
          >
            Weitere fehlgeschlagene Zustellungen laden
          </button>
        )}
      </section>

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

function Result({ result }: { result: ActionResult | null | undefined }) {
  if (!result) return null;
  return result.ok ? (
    <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
      <CheckCircle2 className="h-4 w-4" /> {result.message ?? 'Erledigt.'}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 whitespace-pre-wrap text-xs text-red-700 dark:text-red-400">
      <AlertCircle className="h-4 w-4 shrink-0" /> {result.error ?? 'Fehler.'}
    </span>
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

function RouteState({ endpoint }: { endpoint: N8nEndpointView }) {
  if (endpoint.verificationOk === false)
    return (
      <span
        className="inline-flex items-center gap-1 text-[10px] text-red-700 dark:text-red-400"
        title={endpoint.verificationError ?? undefined}
      >
        <AlertCircle className="h-3 w-3" /> Test fehlgeschlagen
      </span>
    );
  if (!endpoint.enabled && endpoint.verificationOk === true)
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-amber-700 dark:text-amber-300">
        <CheckCircle2 className="h-3 w-3" /> verifiziert, noch deaktiviert
      </span>
    );
  if (!endpoint.enabled)
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-muted">
        <XCircle className="h-3 w-3" /> deaktiviert
      </span>
    );
  if (endpoint.verificationOk === true)
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="h-3 w-3" /> verifiziert
      </span>
    );
  return <span className="text-[10px] text-muted">nicht getestet</span>;
}

function DeliveryState({
  status,
}: {
  status: 'PENDING' | 'PROCESSING' | 'DELIVERED' | 'FAILED' | 'SKIPPED';
}) {
  if (status === 'DELIVERED')
    return (
      <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="h-3 w-3" /> zugestellt
      </span>
    );
  if (status === 'FAILED')
    return (
      <span className="inline-flex items-center gap-1 text-red-700 dark:text-red-400">
        <AlertCircle className="h-3 w-3" /> fehlgeschlagen
      </span>
    );
  if (status === 'SKIPPED') return <span className="text-muted">übersprungen</span>;
  if (status === 'PROCESSING')
    return (
      <span className="inline-flex items-center gap-1 text-blue-700 dark:text-blue-400">
        <Loader2 className="h-3 w-3 animate-spin" /> wird zugestellt
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 text-muted">
      <Loader2 className="h-3 w-3" /> wartend
    </span>
  );
}
