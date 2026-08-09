'use client';

import { KeyRound, RefreshCw, ShieldCheck } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import type { CallbackCredentialResult } from './n8n-actions';
import { N8nActionResult } from './n8n-form-result';
import { CredentialRow, ReadOnlyValue } from './n8n-form-parts';
import type { N8nBrowserConfig } from './n8n-form-types';

const CALLBACK_SCOPE_LABELS: Record<string, string> = {
  'requests:read': 'Anforderungen lesen',
  'gwg:read': 'GwG-Prüfungen lesen',
  'research:write': 'Research-Ergebnis zurückschreiben',
  'inbound-mail:write': 'Eingehende E-Mail zuordnen',
};

interface Props {
  initial: N8nBrowserConfig;
  callbackBaseUrl: string;
  callbackScopes: string[];
  setCallbackScopes: Dispatch<SetStateAction<string[]>>;
  callbackConfigured: boolean;
  callbackResult: CallbackCredentialResult | null;
  setCallbackResult: Dispatch<SetStateAction<CallbackCredentialResult | null>>;
  rotateCallback: () => void;
  busy: boolean;
  saving: boolean;
  copied: string | null;
  copy: (label: string, value: string) => void;
}

export function N8nCallbackCredentialsSection({
  initial,
  callbackBaseUrl,
  callbackScopes,
  setCallbackScopes,
  callbackConfigured,
  callbackResult,
  setCallbackResult,
  rotateCallback,
  busy,
  saving,
  copied,
  copy,
}: Props) {
  return (
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
                Einmalige Anzeige — jetzt als n8n Header-Auth-Credential speichern. Die Anzeige wird
                nach fünf Minuten aus dem Browser-State entfernt.
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
            <p className="font-semibold">
              Für n8n „Header Auth“ (ein Header genügt): Name <code>Authorization</code>, Wert:
            </p>
            <CredentialRow
              label="Authorization (komplett)"
              value={`Bearer ${callbackResult.credential.keyId}.${callbackResult.credential.token}`}
              copied={copied}
              onCopy={copy}
            />
            <details>
              <summary className="cursor-pointer font-medium">
                Alternative: getrennte Header (z.&nbsp;B. für eigene HTTP-Clients)
              </summary>
              <div className="mt-2 space-y-2">
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
              </div>
            </details>
            <p>
              Jeder Fach-Callback benötigt außerdem eine eindeutige{' '}
              <code>X-TaxTronik-Request-Id</code>; der Verbindungstest auf die Callback-URL kommt
              ohne aus.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
