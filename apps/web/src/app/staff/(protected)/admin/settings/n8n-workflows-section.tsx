'use client';

import { Download, Loader2, RefreshCw, Route, Save, Workflow } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { fmtDateTimeShort } from '@/lib/fmt';
import type { ActionResult, N8nDiscoveredWebhookView, N8nWorkflowRow } from './n8n-actions';
import { N8nActionResult } from './n8n-form-result';
import type { BundledWorkflowSummary, N8nBrowserConfig } from './n8n-form-types';

interface Props {
  initial: N8nBrowserConfig;
  bundledWorkflows: BundledWorkflowSummary[];
  selectedTemplates: string[];
  setSelectedTemplates: Dispatch<SetStateAction<string[]>>;
  n8nMailFrom: string;
  setN8nMailFrom: Dispatch<SetStateAction<string>>;
  gwgOfficerEmail: string;
  setGwgOfficerEmail: Dispatch<SetStateAction<string>>;
  workflows: N8nWorkflowRow[] | null;
  workflowError: string | null;
  discovered: N8nDiscoveredWebhookView[] | null;
  discoveryError: string | null;
  importResult: ActionResult | null;
  importWorkflows: () => void;
  loadWorkflows: () => void;
  discoverWebhooks: () => void;
  selectDiscovered: (item: N8nDiscoveredWebhookView) => void;
  selectedDiscoveredKey: string | null;
  selectedDiscoveredCanSave: boolean;
  saveSelectedDiscovered: () => void;
  routeResult: ActionResult | null;
  busy: boolean;
  saving: boolean;
}

export function N8nWorkflowsSection({
  initial,
  bundledWorkflows,
  selectedTemplates,
  setSelectedTemplates,
  n8nMailFrom,
  setN8nMailFrom,
  gwgOfficerEmail,
  setGwgOfficerEmail,
  workflows,
  workflowError,
  discovered,
  discoveryError,
  importResult,
  importWorkflows,
  loadWorkflows,
  discoverWebhooks,
  selectDiscovered,
  selectedDiscoveredKey,
  selectedDiscoveredCanSave,
  saveSelectedDiscovered,
  routeResult,
  busy,
  saving,
}: Props) {
  return (
    <section className="space-y-4" aria-labelledby="n8n-workflows-heading">
      <div>
        <h3
          id="n8n-workflows-heading"
          className="inline-flex items-center gap-2 text-base font-semibold text-primary"
        >
          <Workflow className="h-4 w-4" /> 3. Workflows einrichten
        </h3>
        <p className="mt-1 text-xs text-muted">
          Vorlagen werden nur importiert. Mit <code>credential:create</code> richtet TaxTronik den
          Rückkanal automatisch ein; andernfalls erscheint das Token einmalig zur manuellen
          Übergabe. Kein Workflow wird automatisch aktiviert oder überschrieben.
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
                <span className="mt-1 block text-xs text-muted">
                  Optional beim Import. Leer erzeugt einen deutlich sichtbaren{' '}
                  <code>example.invalid</code>-Platzhalter, der vor Veröffentlichung ersetzt werden
                  muss.
                </span>
              </label>
            )}
            <p className="text-xs text-muted md:col-span-2">
              Diese nicht geheimen Werte werden beim Import direkt in die Vorlage eingesetzt.
              Secrets bleiben ausschließlich verschlüsselte n8n-Credentials bzw. werden bei
              fehlendem API-Recht nur einmalig angezeigt.
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
        {workflowError && <p className="text-xs text-red-700 dark:text-red-400">{workflowError}</p>}
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
              discovered.map((item) => {
                const selected = selectedDiscoveredKey === `${item.workflowId}:${item.nodeId}`;
                return (
                  <div
                    key={`${item.workflowId}:${item.nodeId}:${item.path}`}
                    className="flex flex-wrap items-center justify-between gap-3 rounded border border-default px-3 py-2 text-xs"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-primary">
                        {item.workflowName} · {item.nodeName}
                      </p>
                      <p className="truncate font-mono text-[10px] text-muted">
                        {item.productionUrl || `Pfad: ${item.path} — Webhook-Präfix fehlt`}
                      </p>
                      {selected && (
                        <p className="mt-1 text-[11px] text-blue-800 dark:text-blue-300">
                          {selectedDiscoveredCanSave
                            ? 'Route übernommen. Das zum Workflow gehörende Event ist vorausgewählt.'
                            : 'Route übernommen. Bitte unter „Details bearbeiten“ mindestens ein Event auswählen.'}
                        </p>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {selected ? (
                        <>
                          <button
                            type="button"
                            className="btn-primary inline-flex items-center gap-1.5 text-xs"
                            onClick={saveSelectedDiscovered}
                            disabled={busy || saving || !selectedDiscoveredCanSave}
                          >
                            <Save className="h-3.5 w-3.5" /> Route speichern
                          </button>
                          <button
                            type="button"
                            className="btn-secondary text-xs"
                            onClick={() =>
                              document
                                .getElementById('n8n-route-editor')
                                ?.scrollIntoView({ behavior: 'smooth' })
                            }
                          >
                            Details bearbeiten
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="btn-secondary text-xs"
                          onClick={() => selectDiscovered(item)}
                          disabled={!item.productionUrl}
                        >
                          Als Route übernehmen
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
            <N8nActionResult result={routeResult} />
          </div>
        )}
      </div>
    </section>
  );
}
