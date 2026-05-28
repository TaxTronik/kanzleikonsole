'use client';

import { useActionState, useState, useTransition } from 'react';
import { CheckCircle2, AlertCircle, ShieldCheck, ExternalLink, Send } from 'lucide-react';
import {
  saveTsaAction,
  testTsaAction,
  type ActionResult,
} from './actions';
import type { TsaConfig } from '@/server/settings/tsa';
import type { TsaProvider } from '@taxtronik/evidence';

interface Props {
  initial: TsaConfig;
  providers: TsaProvider[];
  envFallback: string | null;
}

export function TsaForm({ initial, providers, envFallback }: Props) {
  const [providerId, setProviderId] = useState(initial.providerId);
  const [customUrl, setCustomUrl] = useState(initial.customUrl);
  const [testResult, setTestResult] = useState<ActionResult | null>(null);
  const [isTesting, startTest] = useTransition();

  const [saveState, saveAction, isSaving] = useActionState<ActionResult | null, FormData>(
    saveTsaAction,
    null,
  );

  const selected = providers.find((p) => p.id === providerId);
  const isCustom = providerId === 'custom';
  const resolvedUrl = !providerId
    ? null
    : isCustom
      ? customUrl.trim() || null
      : selected?.url || null;

  async function onTest() {
    setTestResult(null);
    startTest(async () => {
      const fd = new FormData();
      fd.set('providerId', providerId);
      fd.set('customUrl', customUrl);
      const r = await testTsaAction(null, fd);
      setTestResult(r);
    });
  }

  return (
    <div className="space-y-6">
      {!initial.providerId && envFallback && (
        <div className="rounded-md border border-blue-200 dark:border-blue-900/60 bg-blue-50 dark:bg-blue-900/20 px-4 py-3 text-xs text-blue-900 dark:text-blue-200">
          Aktuell aktiv: <strong>ENV-Vorgabe</strong> ({envFallback}). Sobald Sie hier
          einen Anbieter auswählen und speichern, wird stattdessen dieser benutzt.
        </div>
      )}
      {!initial.providerId && !envFallback && (
        <div className="rounded-md border border-yellow-200 dark:border-yellow-900/60 bg-yellow-50 dark:bg-yellow-900/20 px-4 py-3 text-xs text-yellow-900 dark:text-yellow-200">
          Aktuell läuft ein <strong>lokaler Self-Timestamp</strong>. Für den produktiven
          Einsatz wird ein externer Zeitstempeldienst empfohlen — sonst hat die
          Hash-Chain nur Selbstauskunft, keinen unabhängigen Drittnachweis.
        </div>
      )}

      <form action={saveAction} className="space-y-4">
        {/* Provider-Liste als Cards */}
        <fieldset className="space-y-2">
          <legend className="label mb-2">Anbieter</legend>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <label
              className={
                providerId === ''
                  ? 'cursor-pointer rounded-md border-2 border-brand-600 bg-brand-50 dark:bg-brand-900/30 p-3'
                  : 'cursor-pointer rounded-md border border-default hover:bg-gray-50 p-3'
              }
            >
              <div className="flex items-start gap-2">
                <input
                  type="radio"
                  name="providerId"
                  value=""
                  checked={providerId === ''}
                  onChange={() => setProviderId('')}
                  className="mt-1"
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-primary">
                    Lokaler Self-Timestamp
                  </div>
                  <div className="text-xs text-muted">
                    Kein externer Dienst — Server-Uhrzeit als Stempel. Nur für Dev/Test.
                  </div>
                </div>
              </div>
            </label>
            {providers.map((p) => (
              <label
                key={p.id}
                className={
                  providerId === p.id
                    ? 'cursor-pointer rounded-md border-2 border-brand-600 bg-brand-50 dark:bg-brand-900/30 p-3'
                    : 'cursor-pointer rounded-md border border-default hover:bg-gray-50 p-3'
                }
              >
                <div className="flex items-start gap-2">
                  <input
                    type="radio"
                    name="providerId"
                    value={p.id}
                    checked={providerId === p.id}
                    onChange={() => setProviderId(p.id)}
                    className="mt-1"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-primary flex items-center gap-1.5 flex-wrap">
                      {p.label}
                      {p.qualified && (
                        <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400 bg-emerald-100 dark:bg-emerald-900/40 rounded px-1 py-0.5">
                          <ShieldCheck className="h-2.5 w-2.5" />
                          eIDAS
                        </span>
                      )}
                      <span
                        className={
                          p.cost === 'free'
                            ? 'text-[10px] font-medium uppercase tracking-wide text-muted bg-gray-100 rounded px-1 py-0.5'
                            : 'text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-900/40 rounded px-1 py-0.5'
                        }
                      >
                        {p.cost === 'free' ? 'kostenlos' : 'kostenpflichtig'}
                      </span>
                      <span className="text-[10px] text-disabled">{p.jurisdiction}</span>
                    </div>
                    <div className="text-xs text-muted">{p.hint}</div>
                    {p.id !== 'custom' && (
                      <div className="text-[10px] text-disabled font-mono mt-0.5 truncate">
                        {p.url}
                      </div>
                    )}
                  </div>
                </div>
              </label>
            ))}
          </div>
        </fieldset>

        {isCustom && (
          <div>
            <label className="label" htmlFor="customUrl">TSA-URL</label>
            <input
              id="customUrl"
              name="customUrl"
              type="url"
              className="input"
              placeholder="https://tsa.example.de/tsr"
              value={customUrl}
              onChange={(e) => setCustomUrl(e.target.value)}
              required={isCustom}
            />
            <p className="text-xs text-muted mt-1">
              Vollständige URL des RFC-3161-Endpoints (POST mit Content-Type{' '}
              <code>application/timestamp-query</code>).
            </p>
          </div>
        )}
        {!isCustom && (
          <input type="hidden" name="customUrl" value={customUrl} />
        )}

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

      {/* Test-Roundtrip */}
      <div className="rounded-md border border-default bg-surface-raised p-4 space-y-2">
        <div className="text-sm font-medium text-primary">
          Verbindung testen
        </div>
        <p className="text-xs text-muted">
          Schickt eine echte TimeStampReq (mit zufälligem Hash) an den ausgewählten
          Server und prüft, ob ein granted Response zurückkommt.
        </p>
        {resolvedUrl && (
          <p className="text-xs text-muted font-mono break-all">{resolvedUrl}</p>
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onTest}
            disabled={isTesting || !resolvedUrl}
            className="btn-secondary inline-flex items-center gap-1.5"
          >
            <Send className="h-3.5 w-3.5" />
            {isTesting ? 'Sende…' : 'Test senden'}
          </button>
          {testResult?.ok && (
            <span className="trend-up">
              <CheckCircle2 className="h-4 w-4" />
              {testResult.error}
            </span>
          )}
          {testResult && !testResult.ok && (
            <span className="trend-down">
              <AlertCircle className="h-4 w-4" />
              {testResult.error}
            </span>
          )}
        </div>
      </div>

      <p className="text-xs text-muted">
        Hintergrund: Die Audit-Hash-Chain wird täglich versiegelt. Mit einem
        externen RFC-3161-Stempel bestätigt eine unabhängige Stelle, dass der
        Tages-Spitzen-Hash zu einem bestimmten Zeitpunkt existierte — Voraussetzung
        für gerichtsfeste Beweisführung.{' '}
        <a
          href="https://www.rfc-editor.org/rfc/rfc3161"
          target="_blank"
          rel="noopener noreferrer"
          className="text-brand-700 hover:underline inline-flex items-center gap-0.5"
        >
          RFC 3161 <ExternalLink className="h-3 w-3" />
        </a>
      </p>
    </div>
  );
}
