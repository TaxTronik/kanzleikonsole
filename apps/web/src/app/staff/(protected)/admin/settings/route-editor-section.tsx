'use client';

import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Plus,
  Save,
  Send,
  Trash2,
  XCircle,
} from 'lucide-react';
import type { Dispatch, FormEventHandler, SetStateAction } from 'react';
import { useEffect, useState } from 'react';
import { OverflowItem, OverflowMenu, OverflowSeparator } from '@/components/overflow-menu';
import { Modal } from '@/components/ui/modal';
import { requiresSeparateTestWebhook, type N8nEventCatalogEntry } from '@taxtronik/n8n-shared';
import type { N8nEndpointView } from '@/server/n8n/status';
import type { ActionResult } from './n8n-actions';
import { N8nActionResult } from './n8n-form-result';

export interface RouteDraft {
  id: string;
  name: string;
  productionUrl: string;
  testUrl: string;
  workflowId: string;
  workflowName: string;
  workflowNodeId: string;
  source: 'MANAGED' | 'DISCOVERED' | 'CUSTOM';
  enabled: boolean;
  testMode: boolean;
  events: string[];
}

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

interface RouteEditorSectionProps {
  endpoints: N8nEndpointView[];
  connectionActive: boolean;
  events: readonly N8nEventCatalogEntry[];
  routeDraft: RouteDraft;
  setRouteDraft: Dispatch<SetStateAction<RouteDraft>>;
  customEvent: string;
  setCustomEvent: Dispatch<SetStateAction<string>>;
  routeResult: ActionResult | null;
  testResult: Record<string, ActionResult>;
  busy: boolean;
  saving: boolean;
  onSaveRoute: FormEventHandler<HTMLFormElement>;
  onEditRoute: (endpoint: N8nEndpointView) => void;
  onDeleteRoute: (endpointId: string) => void;
  onTestRoute: (endpointId: string, useTestUrl: boolean, eventName: string) => void;
  onToggleRoute: (
    endpoint: N8nEndpointView,
    patch: { enabled?: boolean; testMode?: boolean },
  ) => void;
}

export function RouteEditorSection({
  endpoints,
  connectionActive,
  events,
  routeDraft,
  setRouteDraft,
  customEvent,
  setCustomEvent,
  routeResult,
  testResult,
  busy,
  saving,
  onSaveRoute,
  onEditRoute,
  onDeleteRoute,
  onTestRoute,
  onToggleRoute,
}: RouteEditorSectionProps) {
  const groupedEvents = new Map<string, N8nEventCatalogEntry[]>();
  for (const event of events) {
    const list = groupedEvents.get(event.categoryLabel) ?? [];
    list.push(event);
    groupedEvents.set(event.categoryLabel, list);
  }
  const staticEventNames = new Set<string>(events.map((event) => event.name));
  const customRouteEvents = routeDraft.events.filter((event) => !staticEventNames.has(event));
  const routeRequiresTestUrl =
    requiresSeparateTestWebhook(routeDraft.events) || Boolean(customEvent.trim());
  // "Vorbefüllt" heißt: gespeicherte Route in Bearbeitung ODER aus der
  // Webhook-Erkennung übernommen. In beiden Fällen muss ein sichtbarer Weg
  // zurück zu einer leeren eigenen Route existieren — vorher gab es den
  // Reset nur für gespeicherte Routen (id gesetzt), nach "Übernehmen" aus
  // der Erkennung saß man im vorbefüllten Formular fest.
  const draftPrefilled = Boolean(
    routeDraft.id || routeDraft.workflowId || routeDraft.name || routeDraft.productionUrl,
  );
  const editorTitle = routeDraft.id
    ? 'Route bearbeiten'
    : routeDraft.workflowId
      ? 'Erkannte Route übernehmen'
      : 'Eigene Workflow-Route hinzufügen';
  const resetDraft = () => {
    setRouteDraft(EMPTY_ROUTE);
    setCustomEvent('');
  };

  // Editor als Modal: öffnet manuell („Route anlegen") oder automatisch,
  // sobald eine Route bearbeitet/übernommen wird (draftPrefilled). Nach
  // erfolgreichem Speichern setzt n8n-form den Draft zurück → schließt.
  const [manualOpen, setManualOpen] = useState(false);
  const editorOpen = manualOpen || draftPrefilled;
  const closeEditor = () => {
    setManualOpen(false);
    resetDraft();
  };
  useEffect(() => {
    if (routeResult?.ok) setManualOpen(false);
  }, [routeResult]);

  return (
    <section className="space-y-4">
      <p className="rounded bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
        Bei explizitem Routing werden Events <strong>ausschließlich</strong> an die hier
        gespeicherten, aktiven Routen zugestellt — das Webhook-Präfix aus Schritt 1 spielt dabei
        keine Rolle. Ablauf: Workflows importieren und in n8n veröffentlichen →{' '}
        <strong>„Webhooks erkennen“</strong> (Schritt 3) → erkannte Route übernehmen → Events wählen
        → speichern → testen. Ohne aktive Route landet jedes Event unter „Fehlgeschlagen“.
      </p>

      <div className="flex justify-end">
        <button
          type="button"
          className="btn-secondary inline-flex items-center gap-1.5 text-xs"
          onClick={() => setManualOpen(true)}
        >
          <Plus className="h-3.5 w-3.5" /> Route anlegen
        </button>
      </div>

      <div className="space-y-2">
        {endpoints.length === 0 && (
          <div className="rounded-md border border-dashed border-default p-4 text-xs text-muted">
            Noch keine explizite Workflow-Route.
          </div>
        )}
        {endpoints.map((endpoint) => (
          <details key={endpoint.id} className="details-box">
            <summary>
              <ChevronRight className="h-4 w-4" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-primary">
                {endpoint.name}
              </span>
              <RouteState endpoint={endpoint} connectionActive={connectionActive} />
              <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-muted dark:bg-gray-800">
                {endpoint.source.toLowerCase()}
              </span>
              {endpoint.testMode && (
                <span
                  className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
                  title="Echte Zustellungen gehen an die Test-URL (/webhook-test) — nur solange der Workflow in n8n auf ein Testereignis wartet."
                >
                  Test-Modus
                </span>
              )}
            </summary>
            <div className="details-body space-y-2">
              <p
                className="truncate font-mono text-[10px] text-muted"
                title={endpoint.productionUrl}
              >
                {endpoint.productionUrl}
              </p>
              <div className="flex flex-wrap gap-1">
                {endpoint.events.map((event) => (
                  <code
                    key={event}
                    className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-800 dark:bg-blue-950/40 dark:text-blue-300"
                  >
                    {event}
                  </code>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {(!endpoint.enabled || !connectionActive) && (
                  <button
                    type="button"
                    className="btn-primary inline-flex items-center gap-1 text-xs"
                    onClick={() => onToggleRoute(endpoint, { enabled: true })}
                    disabled={busy || saving}
                  >
                    <CheckCircle2 className="h-3 w-3" />{' '}
                    {endpoint.enabled ? 'Integration aktivieren' : 'Aktivieren'}
                  </button>
                )}
                <button
                  type="button"
                  className="btn-secondary text-xs"
                  onClick={() => onEditRoute(endpoint)}
                  disabled={busy || saving}
                >
                  Bearbeiten
                </button>
                {/* Sekundär-/Gefahren-Aktionen gebündelt im Overflow-Menü */}
                <OverflowMenu>
                  {endpoint.enabled && connectionActive && (
                    <OverflowItem
                      disabled={busy || saving}
                      onSelect={() => onToggleRoute(endpoint, { enabled: false })}
                    >
                      Deaktivieren
                    </OverflowItem>
                  )}
                  {endpoint.testUrl && (
                    <OverflowItem
                      disabled={busy || saving}
                      onSelect={() => onToggleRoute(endpoint, { testMode: !endpoint.testMode })}
                    >
                      {endpoint.testMode ? 'Test-Modus aus' : 'Test-Modus an'}
                    </OverflowItem>
                  )}
                  {endpoint.events.includes('taxtronik.ping') && (
                    <OverflowItem
                      icon={<Send className="h-3.5 w-3.5" />}
                      disabled={busy || saving}
                      onSelect={() => onTestRoute(endpoint.id, false, 'taxtronik.ping')}
                    >
                      Produktion testen
                    </OverflowItem>
                  )}
                  {endpoint.testUrl &&
                    endpoint.events.map((eventName) => (
                      <OverflowItem
                        key={eventName}
                        disabled={busy || saving}
                        onSelect={() => onTestRoute(endpoint.id, true, eventName)}
                      >
                        Test: {eventName}
                      </OverflowItem>
                    ))}
                  <OverflowSeparator />
                  <OverflowItem
                    danger
                    icon={<Trash2 className="h-3.5 w-3.5" />}
                    disabled={busy || saving}
                    onSelect={() => onDeleteRoute(endpoint.id)}
                  >
                    Route löschen
                  </OverflowItem>
                </OverflowMenu>
              </div>
              <N8nActionResult result={testResult[`${endpoint.id}:toggle`]} />
              {endpoint.events.map((eventName) => (
                <div key={eventName}>
                  <N8nActionResult result={testResult[`${endpoint.id}:prod:${eventName}`]} />
                  <N8nActionResult result={testResult[`${endpoint.id}:test:${eventName}`]} />
                </div>
              ))}
            </div>
          </details>
        ))}
      </div>

      {/* Editor als Modal über der Routenliste (Plan B): öffnet über
          „Route anlegen", „Bearbeiten" oder „Als Route übernehmen".
          Der globale Settings-Flyover kann diesen kontrollierten React-State
          nicht serialisieren — eigene Aktionen bleiben deshalb sichtbar. */}
      {editorOpen && (
        <Modal title={editorTitle} onClose={closeEditor} maxWidth="max-w-3xl">
          <form
            id="n8n-route-editor"
            data-settings-no-track
            onSubmit={onSaveRoute}
            className="max-h-[75vh] space-y-4 overflow-y-auto pr-1"
          >
            {routeDraft.workflowId && !routeDraft.id && (
              <p className="rounded bg-blue-50 px-3 py-2 text-xs text-blue-900 dark:bg-blue-950/30 dark:text-blue-200">
                Aus der Webhook-Erkennung übernommen: <strong>{routeDraft.workflowName}</strong>.
                Unten die TaxTronik-Events ankreuzen, die diesen Workflow beliefern sollen, dann{' '}
                <strong>Route speichern</strong>.
              </p>
            )}
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
              <div className="flex flex-col gap-1 self-end pb-2">
                <label className="inline-flex items-center gap-2 text-xs text-primary">
                  <input
                    type="checkbox"
                    className="switch"
                    checked={routeDraft.enabled}
                    onChange={(event) =>
                      setRouteDraft((current) => ({ ...current, enabled: event.target.checked }))
                    }
                  />{' '}
                  Route aktiv
                </label>
                <label className="inline-flex items-center gap-2 text-xs text-primary">
                  <input
                    type="checkbox"
                    className="switch"
                    checked={routeDraft.testMode}
                    disabled={!routeDraft.testUrl}
                    onChange={(event) =>
                      setRouteDraft((current) => ({ ...current, testMode: event.target.checked }))
                    }
                  />{' '}
                  Test-Modus (Zustellung an /webhook-test)
                </label>
              </div>
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
                  {routeRequiresTestUrl
                    ? '(erforderlich)'
                    : '(optional für reinen Verbindungstest)'}
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
                  Die URL muss <code>/webhook-test/</code> enthalten und funktioniert nur, während
                  der Workflow in n8n auf ein Testereignis wartet. Für Fach-Events ist sie Pflicht,
                  weil TaxTronik synthetische Fachdaten nie an Produktion sendet. Sie wird nie für
                  echte Zustellungen genutzt.
                </span>
              </label>
            </div>

            <fieldset>
              <legend className="label">TaxTronik-Events</legend>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {[...groupedEvents.entries()].map(([category, categoryEvents]) => (
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
                          htmlFor={`n8n-route-event-${event.name}`}
                        >
                          <input
                            id={`n8n-route-event-${event.name}`}
                            type="checkbox"
                            className="switch mt-0.5"
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
                          <span className="block">
                            {event.label}
                            <code className="block text-[10px] text-muted">{event.name}</code>
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
                Diese Auswahl kann personenbezogene Daten bzw. Berufsgeheimnisse betreffen. Im
                eigenen n8n-Workflow nur erforderliche Daten verarbeiten und Ausführungsdaten
                begrenzen.
              </p>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-default pt-3">
              <div className="min-w-0 flex-1">
                <N8nActionResult result={routeResult} />
              </div>
              <div className="ml-auto flex items-center justify-end gap-2">
                {draftPrefilled && (
                  <button
                    type="button"
                    className="btn-ghost text-xs"
                    onClick={resetDraft}
                    disabled={busy || saving}
                  >
                    Neue leere Route
                  </button>
                )}
                <button
                  type="button"
                  className="btn-secondary inline-flex items-center gap-1.5"
                  onClick={closeEditor}
                  disabled={busy || saving}
                >
                  <XCircle className="h-4 w-4" /> Verwerfen
                </button>
                <button
                  type="submit"
                  className="btn-primary inline-flex items-center gap-1.5"
                  disabled={busy || saving}
                >
                  <Save className="h-4 w-4" /> Speichern
                </button>
              </div>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}

function RouteState({
  endpoint,
  connectionActive,
}: {
  endpoint: N8nEndpointView;
  connectionActive: boolean;
}) {
  if (endpoint.verificationOk === false)
    return (
      <span
        className="inline-flex items-center gap-1 text-[10px] text-red-700 dark:text-red-400"
        title={endpoint.verificationError ?? undefined}
      >
        <AlertCircle className="h-3 w-3" /> Test fehlgeschlagen
      </span>
    );
  if (endpoint.verificationOk === true && !endpoint.enabled)
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
  if (!connectionActive)
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-amber-700 dark:text-amber-300">
        <AlertCircle className="h-3 w-3" /> Route aktiv, Integration gesperrt
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
