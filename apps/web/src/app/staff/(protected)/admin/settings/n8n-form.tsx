'use client';

import { useActionState, useState, useTransition } from 'react';
import {
  CheckCircle2,
  AlertCircle,
  Send,
  RefreshCw,
  Workflow,
  Plug,
  Download,
} from 'lucide-react';
import {
  saveN8nAction,
  resetN8nAction,
  testN8nPingAction,
  testN8nApiAction,
  importWorkflowsAction,
  listWorkflowsAction,
  type ActionResult,
} from './n8n-actions';
import type { N8nConfig } from '@/server/settings/n8n';

interface Props {
  initial: N8nConfig | null;
  envHints: {
    webhookBaseUrl: string;
    hasHmacSecret: boolean;
  };
}

const dateFmt = new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short' });

interface WorkflowRow {
  id: string;
  name: string;
  active: boolean;
  updatedAt: string;
}

export function N8nForm({ initial, envHints }: Props) {
  const hasInitial = Boolean(initial);
  const [webhookBaseUrl, setWebhookBaseUrl] = useState(initial?.webhookBaseUrl ?? envHints.webhookBaseUrl);
  const [hmacSecret, setHmacSecret] = useState('');
  const [keepHmac, setKeepHmac] = useState(Boolean(initial?.hmacSecret));
  const [apiBaseUrl, setApiBaseUrl] = useState(initial?.apiBaseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [keepApiKey, setKeepApiKey] = useState(Boolean(initial?.apiKey));

  const hasStoredHmac = Boolean(initial?.hmacSecret);
  const hasStoredApiKey = Boolean(initial?.apiKey);

  const [saveState, saveAction, isSaving] = useActionState<ActionResult | null, FormData>(
    saveN8nAction,
    null,
  );

  const [pingResult, setPingResult] = useState<ActionResult | null>(null);
  const [isPinging, startPing] = useTransition();

  const [apiResult, setApiResult] = useState<ActionResult | null>(null);
  const [isTestingApi, startApi] = useTransition();

  const [importResult, setImportResult] = useState<ActionResult | null>(null);
  const [isImporting, startImport] = useTransition();
  const [workflows, setWorkflows] = useState<WorkflowRow[] | null>(null);
  const [isListing, startList] = useTransition();
  const [listError, setListError] = useState<string | null>(null);

  function buildFormData(): FormData {
    const fd = new FormData();
    fd.set('webhookBaseUrl', webhookBaseUrl);
    fd.set('hmacSecret', hmacSecret);
    fd.set('apiBaseUrl', apiBaseUrl);
    fd.set('apiKey', apiKey);
    if (keepHmac) fd.set('keepHmac', 'on');
    if (keepApiKey) fd.set('keepApiKey', 'on');
    return fd;
  }

  function onPing() {
    setPingResult(null);
    startPing(async () => {
      const r = await testN8nPingAction(null, buildFormData());
      setPingResult(r);
    });
  }
  function onApiTest() {
    setApiResult(null);
    startApi(async () => {
      const r = await testN8nApiAction(null, buildFormData());
      setApiResult(r);
    });
  }
  function onImport() {
    setImportResult(null);
    startImport(async () => {
      const r = await importWorkflowsAction();
      setImportResult(r);
      // Liste nach Import neu laden
      const list = await listWorkflowsAction();
      if (list.ok && list.workflows) setWorkflows(list.workflows);
    });
  }
  function onList() {
    setListError(null);
    startList(async () => {
      const r = await listWorkflowsAction();
      if (r.ok && r.workflows) setWorkflows(r.workflows);
      else setListError(r.error ?? 'Unbekannter Fehler.');
    });
  }
  function onReset() {
    if (!confirm('n8n-Konfiguration zurücksetzen? Outbound-Events laufen danach wieder über die ENV-Vorgabe.')) return;
    startPing(async () => {
      await resetN8nAction();
      window.location.reload();
    });
  }

  return (
    <div className="space-y-6">
      {!hasInitial && (
        <div className="rounded-md border border-blue-200 dark:border-blue-900/60 bg-blue-50 dark:bg-blue-900/20 px-4 py-3 text-xs text-blue-900 dark:text-blue-200">
          Aktuell aktiv: <strong>ENV-Vorgabe</strong>{' '}
          (
          {envHints.webhookBaseUrl || '— Webhook-URL nicht gesetzt —'}
          {', '}
          HMAC: {envHints.hasHmacSecret ? 'gesetzt' : '— fehlt —'}
          ). Sobald Sie hier speichern, gilt diese Kanzlei-Konfiguration.
        </div>
      )}

      {/* Outbound — Webhook + HMAC */}
      <form action={saveAction} className="space-y-4">
        <h3 className="text-sm font-semibold text-primary inline-flex items-center gap-2">
          <Send className="h-4 w-4 text-disabled" />
          Outbound — App → n8n (Webhook)
        </h3>
        <p className="text-xs text-muted">
          Die App schickt Events (z. B. <code>request.opened</code>, <code>gwg.expired</code>) als
          POST an <code>&lt;Webhook-URL&gt;/&lt;event-name&gt;</code> mit HMAC-Signatur im Header.
        </p>

        <div>
          <label className="label" htmlFor="webhookBaseUrl">Webhook-Basis-URL</label>
          <input
            id="webhookBaseUrl"
            name="webhookBaseUrl"
            type="url"
            className="input"
            value={webhookBaseUrl}
            onChange={(e) => setWebhookBaseUrl(e.target.value)}
            placeholder="http://localhost:5678/webhook"
          />
          <p className="text-xs text-muted mt-1">
            Endpoint der n8n-Webhook-Knoten — typisch <code>{`{n8n-host}/webhook`}</code>.
          </p>
        </div>

        <div>
          <label className="label" htmlFor="hmacSecret">HMAC-Secret</label>
          <input
            id="hmacSecret"
            name="hmacSecret"
            type="password"
            className="input"
            value={hmacSecret}
            onChange={(e) => { setHmacSecret(e.target.value); if (e.target.value) setKeepHmac(false); }}
            placeholder={hasStoredHmac && keepHmac ? '⬢⬢⬢⬢⬢⬢⬢⬢' : 'zufälliger String, mind. 32 Zeichen'}
            autoComplete="new-password"
          />
          {hasStoredHmac && (
            <label className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted">
              <input
                type="checkbox"
                checked={keepHmac}
                onChange={(e) => { setKeepHmac(e.target.checked); if (e.target.checked) setHmacSecret(''); }}
              />
              Gespeichertes Secret beibehalten
            </label>
          )}
          <p className="text-xs text-muted mt-1">
            Identisch zur ENV-Variable <code>N8N_HMAC_SECRET</code> in den n8n-Workflows.
          </p>
        </div>

        {/* Inbound — n8n-API */}
        <h3 className="text-sm font-semibold text-primary inline-flex items-center gap-2 pt-2 border-t border-default mt-4 w-full">
          <Plug className="h-4 w-4 text-disabled" />
          REST-API — Workflows verwalten
        </h3>
        <p className="text-xs text-muted">
          Wird benutzt, um Workflows aus der App heraus zu listen, zu importieren und zu
          aktivieren. API-Key in der n8n-UI unter <em>Settings → API</em> erzeugen.
        </p>

        <div>
          <label className="label" htmlFor="apiBaseUrl">API-Basis-URL</label>
          <input
            id="apiBaseUrl"
            name="apiBaseUrl"
            type="url"
            className="input"
            value={apiBaseUrl}
            onChange={(e) => setApiBaseUrl(e.target.value)}
            placeholder="http://localhost:5678/api/v1"
          />
        </div>

        <div>
          <label className="label" htmlFor="apiKey">API-Key</label>
          <input
            id="apiKey"
            name="apiKey"
            type="password"
            className="input"
            value={apiKey}
            onChange={(e) => { setApiKey(e.target.value); if (e.target.value) setKeepApiKey(false); }}
            placeholder={hasStoredApiKey && keepApiKey ? '⬢⬢⬢⬢⬢⬢⬢⬢' : 'n8n-API-Key (lang)'}
            autoComplete="new-password"
          />
          {hasStoredApiKey && (
            <label className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted">
              <input
                type="checkbox"
                checked={keepApiKey}
                onChange={(e) => { setKeepApiKey(e.target.checked); if (e.target.checked) setApiKey(''); }}
              />
              Gespeicherten API-Key beibehalten
            </label>
          )}
        </div>

        <div className="flex items-center justify-between pt-2">
          <button type="submit" className="btn-primary" disabled={isSaving}>
            {isSaving ? 'Speichere…' : 'Speichern'}
          </button>
          {saveState?.ok && (
            <span className="trend-up">
              <CheckCircle2 className="h-4 w-4" />
              Gespeichert.
            </span>
          )}
          {saveState && !saveState.ok && (
            <span className="trend-down">
              <AlertCircle className="h-4 w-4" />
              {saveState.error}
            </span>
          )}
        </div>
      </form>

      {/* Test-Buttons */}
      <div className="rounded-md border border-default bg-surface-raised p-4 space-y-3">
        <div className="text-sm font-medium text-primary">Diagnose</div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onPing}
            disabled={isPinging || !webhookBaseUrl}
            className="btn-secondary inline-flex items-center gap-1.5"
          >
            <Send className="h-3.5 w-3.5" />
            Webhook-Ping
          </button>
          {pingResult?.ok && (
            <span className="trend-up">
              <CheckCircle2 className="h-4 w-4" /> {pingResult.message}
            </span>
          )}
          {pingResult && !pingResult.ok && (
            <span className="trend-down">
              <AlertCircle className="h-4 w-4" /> {pingResult.error}
            </span>
          )}
        </div>
        <p className="text-xs text-muted -mt-2 pl-1">
          Sendet ein <code>taxtronik.ping</code>-Event an{' '}
          <code>{webhookBaseUrl.replace(/\/$/, '') || '…'}/taxtronik.ping</code>. n8n muss dafür
          einen Webhook-Knoten mit Pfad <code>taxtronik.ping</code> haben (HTTP 200 = OK).
        </p>

        <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-default">
          <button
            type="button"
            onClick={onApiTest}
            disabled={isTestingApi || !apiBaseUrl}
            className="btn-secondary inline-flex items-center gap-1.5"
          >
            <Plug className="h-3.5 w-3.5" />
            API-Test
          </button>
          {apiResult?.ok && (
            <span className="trend-up">
              <CheckCircle2 className="h-4 w-4" /> {apiResult.message}
            </span>
          )}
          {apiResult && !apiResult.ok && (
            <span className="trend-down">
              <AlertCircle className="h-4 w-4" /> {apiResult.error}
            </span>
          )}
        </div>
      </div>

      {/* Workflows-Verwaltung — nur nach Speichern verfügbar */}
      {hasInitial && initial?.apiBaseUrl && initial?.apiKey && (
        <div className="rounded-md border border-default p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-primary inline-flex items-center gap-2">
              <Workflow className="h-4 w-4 text-disabled" />
              Workflows
            </h3>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onList}
                disabled={isListing}
                className="btn-secondary text-xs inline-flex items-center gap-1.5"
              >
                <RefreshCw className={isListing ? 'h-3 w-3 animate-spin' : 'h-3 w-3'} />
                Liste laden
              </button>
              <button
                type="button"
                onClick={onImport}
                disabled={isImporting}
                className="btn-primary text-xs inline-flex items-center gap-1.5"
              >
                <Download className="h-3 w-3" />
                {isImporting ? 'Importiere…' : 'Mitgelieferte importieren'}
              </button>
            </div>
          </div>

          {importResult?.ok && (
            <div className="text-xs text-emerald-700 dark:text-emerald-400">{importResult.message}</div>
          )}
          {importResult && !importResult.ok && (
            <div className="text-xs text-red-700 dark:text-red-400 whitespace-pre-wrap">
              {importResult.error ?? importResult.message}
            </div>
          )}
          {listError && (
            <div className="text-xs text-red-700 dark:text-red-400">{listError}</div>
          )}

          {workflows && workflows.length === 0 && (
            <p className="text-xs text-muted">
              Keine Workflows in dieser n8n-Instanz. Klicken Sie auf „Mitgelieferte importieren".
            </p>
          )}
          {workflows && workflows.length > 0 && (
            <ul className="divide-y divide-border-subtle text-sm">
              {workflows.map((w) => (
                <li key={w.id} className="py-2 flex items-center justify-between gap-2">
                  <span className="text-primary truncate">{w.name}</span>
                  <span className="flex items-center gap-2 shrink-0">
                    {w.active ? (
                      <span className="text-[10px] font-semibold uppercase text-emerald-700 dark:text-emerald-400 bg-emerald-100 dark:bg-emerald-900/40 rounded px-1.5 py-0.5">
                        aktiv
                      </span>
                    ) : (
                      <span className="text-[10px] font-semibold uppercase text-muted bg-gray-100 rounded px-1.5 py-0.5">
                        inaktiv
                      </span>
                    )}
                    <span className="text-[10px] text-disabled">
                      {dateFmt.format(new Date(w.updatedAt))}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}

          <p className="text-xs text-muted pt-2 border-t border-default">
            „Mitgelieferte importieren" lädt die Workflow-JSONs aus
            <code className="ml-1">infra/n8n/workflows/</code> in n8n hoch und aktiviert sie.
            Bestehende Workflows mit identischem Namen werden übersprungen.
          </p>
        </div>
      )}

      {hasInitial && (
        <div className="border-t border-default pt-4">
          <button
            type="button"
            onClick={onReset}
            className="text-xs text-muted hover:text-red-700 dark:hover:text-red-400 inline-flex items-center gap-1.5"
          >
            <RefreshCw className="h-3 w-3" />
            Konfiguration zurücksetzen (wieder ENV-Fallback verwenden)
          </button>
        </div>
      )}
    </div>
  );
}
