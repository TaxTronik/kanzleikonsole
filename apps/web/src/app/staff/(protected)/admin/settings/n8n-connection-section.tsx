'use client';

import { Link2, Loader2, Save } from 'lucide-react';
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

function canTestN8nApi(apiBaseUrl: string, apiKey: string, keepApiKey: boolean): boolean {
  return Boolean(apiBaseUrl && (apiKey || keepApiKey));
}

function ManagedN8nProvisionNotice({ initial }: { initial: N8nBrowserConfig }) {
  if (initial.kind !== 'BUNDLED' || !initial.connectionId || initial.hasApiKey) return null;
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
      <p className="font-medium">Die verwaltete n8n-Instanz ist bereits verbunden.</p>
      <p className="mt-1 text-xs">
        Melden Sie sich einmal als Instanz-Owner in n8n an und erzeugen Sie dort unter{' '}
        <span className="font-medium">Einstellungen → n8n API</span> einen API-Key. Tragen Sie ihn
        unten ein. Für signierte Event-Workflows erzeugen Sie anschließend das
        Outbound-Signatur-Secret, kopieren es einmal in den n8n-Workflow und speichern die
        Verbindung. Die öffentliche Domain samt API- und Webhook-Pfad hat der Deploy bereits
        vorbelegt.
      </p>
    </div>
  );
}

function HmacSecretEditor({
  hmacSecret,
  hasSigningSecret,
  keepHmac,
  busy,
  saving,
  copied,
  dispatchConnection,
  generateSecret,
  copy,
}: Pick<N8nConnectionState, 'hmacSecret' | 'hasSigningSecret' | 'keepHmac'> &
  Pick<Props, 'busy' | 'saving' | 'copied' | 'dispatchConnection' | 'generateSecret' | 'copy'>) {
  return (
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
              hasSigningSecret && keepHmac
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
      {hasSigningSecret && (
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
            Neues HMAC-Secret erzeugt, noch nicht gespeichert. Jetzt in n8n als HMAC-Credential
            hinterlegen; nach dem Speichern zeigt TaxTronik nur noch den sicheren Status an.
          </span>
          <CopyButton label="HMAC" value={hmacSecret} copied={copied} onCopy={copy} />
        </div>
      )}
      {!hmacSecret && hasSigningSecret && keepHmac && (
        <p className="mt-2 rounded bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">
          Ein aktuelles HMAC-Signatur-Secret ist gespeichert. Der geheime Wert wird nicht erneut
          angezeigt.
        </p>
      )}
      {!hmacSecret && hasSigningSecret && !keepHmac && (
        <p className="mt-2 rounded bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          Das aktuell gespeicherte HMAC-Secret wird beim nächsten Speichern entfernt.
        </p>
      )}
    </div>
  );
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
    hasSigningSecret,
    keepHmac,
  } = connection;

  return (
    <section className="space-y-4">
      <ManagedN8nProvisionNotice initial={initial} />

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
              placeholder={'https://n8n.example.de/webhook'}
            />
            <span className="mt-1 block text-xs text-muted">
              Nur zur Erkennung bzw. im Legacy-Modus. Zugestellt wird bei explizitem Routing an die
              unten gespeicherten vollständigen URLs. Für verwaltete Installationen wird die
              öffentliche n8n-Domain automatisch vorbelegt. Der interne Compose-Service ist nur ein
              Reverse-Proxy-Upstream.
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
            <span className="mt-1 block text-xs text-muted">
              Für den vollständigen Ein-Schritt-Import benötigt der Key <code>workflow:list</code>,{' '}
              <code>workflow:create</code>, <code>credential:list</code> und{' '}
              <code>credential:create</code>. Fehlen die Credential-Rechte, bleibt der Import
              möglich und TaxTronik zeigt das Rückkanal-Token einmalig zur manuellen Anlage.
            </span>
            {apiInstanceChanged && !apiKey && (
              <span className="mt-1 block text-xs text-amber-700 dark:text-amber-300">
                Die Public-API-Adresse zeigt auf eine andere n8n-Instanz — bitte den API-Key dieser
                Instanz eingeben. Der gespeicherte Key wird aus Sicherheitsgründen nicht an einen
                fremden Host gesendet.
              </span>
            )}
          </label>
        </div>

        <HmacSecretEditor
          hmacSecret={hmacSecret}
          hasSigningSecret={hasSigningSecret}
          keepHmac={keepHmac}
          busy={busy}
          saving={saving}
          copied={copied}
          dispatchConnection={dispatchConnection}
          generateSecret={generateSecret}
          copy={copy}
        />

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
            disabled={busy || saving || !canTestN8nApi(apiBaseUrl, apiKey, keepApiKey)}
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
