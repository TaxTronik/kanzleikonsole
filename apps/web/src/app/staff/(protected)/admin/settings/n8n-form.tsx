'use client';

import { ExternalLink, Trash2 } from 'lucide-react';
import { useActionState, useEffect, useReducer, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { N8nEventCatalogEntry } from '@taxtronik/n8n-shared';
import type { N8nSetupStatus } from '@/server/n8n/status';
import {
  generateSigningSecretAction,
  resetN8nAction,
  saveN8nAction,
  testN8nApiAction,
  type ActionResult,
} from './n8n-actions';
import {
  createN8nConnectionState,
  n8nConnectionFormData,
  n8nConnectionReducer,
} from './n8n-connection-state';
import { Stage } from '@/components/stage';
import { withActiveStep } from '@/components/stepper';
import { DeliveryOperationsSection } from './delivery-operations-section';
import { RouteEditorSection } from './route-editor-section';
import { useConfirmedAction } from './use-confirmed-action';
import {
  discoveredRouteCanBeSaved,
  isExplicitConnectionActive,
  selectedDiscoveredRouteKey,
} from './n8n-form-state';
import {
  useCopyFeedback,
  useN8nCallbackCredentials,
  useN8nDeliveryOperations,
  useN8nRoutes,
  useN8nWorkflowSetup,
} from './n8n-form-hooks';
import { N8nSetupOverview } from './n8n-setup-overview';
import { N8nConnectionSection } from './n8n-connection-section';
import { N8nCallbackCredentialsSection } from './n8n-callback-credentials-section';
import { N8nWorkflowsSection } from './n8n-workflows-section';
import type { BundledWorkflowSummary, N8nBrowserConfig } from './n8n-form-types';

export type { N8nBrowserConfig } from './n8n-form-types';
export { discoveredRouteDraft } from './n8n-form-state';

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

/** Derive only the five visible setup stages; action payloads live in N8nForm and n8n-form-state.ts. */
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
  const { uiBaseUrl, callbackBaseUrl, apiBaseUrl } = connection;
  const [saveState, saveAction, saving] = useActionState<ActionResult | null, FormData>(
    saveN8nAction,
    null,
  );
  const [busy, startTransition] = useTransition();
  const [apiResult, setApiResult] = useState<ActionResult | null>(null);

  useEffect(() => {
    if (saveState?.ok) {
      dispatchConnection({ type: 'saved' });
      router.refresh();
    }
  }, [router, saveState]);

  // Ein Hook je Stufe; alle teilen die eine Transition (globale Busy-Semantik).
  const runtime = { startTransition, router };
  const { copied, copy } = useCopyFeedback();
  const callback = useN8nCallbackCredentials(initial, bundledWorkflows, runtime);
  const workflowSetup = useN8nWorkflowSetup(bundledWorkflows, runtime, callback.recordImport);
  const routes = useN8nRoutes({ bundledWorkflows, events, dispatchConnection }, runtime);
  const deliveries = useN8nDeliveryOperations(status, runtime);

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
    callback.callbackConfigured,
  );
  const stageStates = withActiveStep(setupSteps);

  function testApi() {
    setApiResult(null);
    startTransition(async () =>
      setApiResult(await testN8nApiAction(null, n8nConnectionFormData(connection))),
    );
  }

  function generateSecret() {
    startTransition(async () => {
      const result = await generateSigningSecretAction();
      if (result.ok && result.secret) {
        dispatchConnection({ type: 'generated-signing-secret', secret: result.secret });
      }
    });
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
          callback.callbackConfigured ? (
            <span className="badge badge-green">Konfiguriert</span>
          ) : (
            <span className="badge badge-gray">Offen</span>
          )
        }
      >
        <N8nCallbackCredentialsSection
          initial={initial}
          callbackBaseUrl={callbackBaseUrl}
          callbackScopes={callback.callbackScopes}
          setCallbackScopes={callback.setCallbackScopes}
          callbackConfigured={callback.callbackConfigured}
          callbackResult={callback.callbackResult}
          setCallbackResult={callback.setCallbackResult}
          rotateCallback={callback.rotateCallback}
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
          selectedTemplates={workflowSetup.selectedTemplates}
          setSelectedTemplates={workflowSetup.setSelectedTemplates}
          n8nMailFrom={workflowSetup.n8nMailFrom}
          setN8nMailFrom={workflowSetup.setN8nMailFrom}
          gwgOfficerEmail={workflowSetup.gwgOfficerEmail}
          setGwgOfficerEmail={workflowSetup.setGwgOfficerEmail}
          workflows={workflowSetup.workflows}
          workflowError={workflowSetup.workflowError}
          discovered={workflowSetup.discovered}
          discoveryError={workflowSetup.discoveryError}
          importResult={workflowSetup.importResult}
          importWorkflows={workflowSetup.importWorkflows}
          loadWorkflows={workflowSetup.loadWorkflows}
          discoverWebhooks={workflowSetup.discoverWebhooks}
          selectDiscovered={routes.selectDiscovered}
          selectedDiscoveredKey={selectedDiscoveredRouteKey(routes.routeDraft)}
          selectedDiscoveredCanSave={discoveredRouteCanBeSaved(routes.routeDraft)}
          saveSelectedDiscovered={routes.persistRouteDraft}
          routeResult={routes.routeResult}
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
          routeDraft={routes.routeDraft}
          setRouteDraft={routes.setRouteDraft}
          customEvent={routes.customEvent}
          setCustomEvent={routes.setCustomEvent}
          routeResult={routes.routeResult}
          testResult={routes.testResult}
          busy={busy}
          saving={saving}
          onSaveRoute={routes.saveRoute}
          onEditRoute={routes.editRoute}
          onDeleteRoute={routes.deleteRoute}
          onTestRoute={routes.testRoute}
          onToggleRoute={routes.toggleRoute}
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
          failedDeliveries={deliveries.failedDeliveries}
          failedCursor={deliveries.failedCursor}
          hasMoreFailedDeliveries={deliveries.hasMoreFailedDeliveries}
          deliveryOperationResult={deliveries.deliveryOperationResult}
          retryResult={deliveries.retryResult}
          replayResult={deliveries.replayResult}
          busy={busy}
          saving={saving}
          onReplayUnroutedEvent={deliveries.replayUnroutedEvent}
          onSkipUnroutedEvent={deliveries.skipUnroutedEvent}
          onRetryDelivery={deliveries.retryDelivery}
          onAcknowledgeDelivery={deliveries.acknowledgeDelivery}
          onLoadMoreFailedDeliveries={deliveries.loadMoreFailedDeliveries}
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
