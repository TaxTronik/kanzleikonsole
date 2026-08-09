'use client';

import { ExternalLink, Link2, Loader2, Save, Settings2 } from 'lucide-react';
import type { Dispatch } from 'react';
import type { ActionResult } from './n8n-actions';
import type { N8nConnectionAction, N8nConnectionState } from './n8n-connection-state';
import { N8nActionResult } from './n8n-form-result';
import { CopyButton, ModeOption, SecretKeep } from './n8n-form-parts';
import type { N8nBrowserConfig } from './n8n-form-types';

interface Props {
  initial: N8nBrowserConfig;
  connection: N8nConnectionState;
  dispatchConnection: Dispatch<N8nConnectionAction>;
  saveAction: (payload: FormData) => void;
  saving: boolean;
  busy: boolean;
  apiInstanceChanged: boolean;
  generateSecret: () => void;
  testApi: () => void;
  saveState: ActionResult | null;
  apiResult: ActionResult | null;
  copied: string | null;
  copy: (label: string, value: string) => void;
}

function urlOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}

export function N8nConnectionSection({
  initial,
  connection,
  dispatchConnection,
  saveAction,
  saving,
  busy,
  apiInstanceChanged,
  generateSecret,
  testApi,
  saveState,
  apiResult,
  copied,
  copy,
}: Props) {
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

  return (
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
            UI, Public API und Webhook-Präfix sind verschiedene URLs. Bei einem Reverse-Proxy können
            sie unterschiedliche öffentliche Pfade haben.
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
        {enabled && routingMode !== 'DISABLED' && <input type="hidden" name="enabled" value="on" />}
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
              Zum späteren Öffnen aus TaxTronik — nur die Basis-Adresse, ohne <code>/webhook</code>.
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
              Nur zur Erkennung bzw. im Legacy-Modus. Zugestellt wird bei explizitem Routing an die
              unten gespeicherten vollständigen URLs.
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
                Die Public-API-Adresse zeigt auf eine andere n8n-Instanz — bitte den API-Key dieser
                Instanz eingeben. Der gespeicherte Key wird aus Sicherheitsgründen nicht an einen
                fremden Host gesendet.
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
                Jetzt in n8n als HMAC-Credential hinterlegen; nach dem Speichern zeigt TaxTronik es
                nicht erneut.
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
  );
}
