'use client';

import { useActionState } from 'react';
import { saveMailDispatchAction, type ActionResult } from './actions';
import type { MailDispatchConfig } from '@/server/settings/mail-dispatch';

export function MailDispatchForm({ initial }: { initial: MailDispatchConfig }) {
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    saveMailDispatchAction,
    null,
  );

  return (
    <form action={formAction} className="space-y-4">
      <fieldset className="space-y-3">
        <legend className="sr-only">Mail-Dispatch-Modus</legend>

        <label
          className="flex items-start gap-3 cursor-pointer"
          htmlFor="mail-dispatch-mode-app"
          aria-label="Nur App-eigener Versand"
        >
          <input
            id="mail-dispatch-mode-app"
            type="radio"
            name="mode"
            value="APP"
            defaultChecked={initial.mode === 'APP'}
            className="mt-1 h-4 w-4 text-brand-600 border-strong focus:ring-focus"
          />
          <span>
            <span className="block text-sm font-medium text-primary">
              Nur App-eigener Versand <span className="text-xs text-muted">(Default)</span>
            </span>
            <span className="block text-xs text-secondary dark:text-disabled">
              Alle Mails werden direkt über das SMTP-Modul mit den EmailTemplate-Vorlagen
              verschickt. n8n bleibt deaktiviert. Empfohlen für Kanzleien ohne externe
              Workflow-Engine.
            </span>
          </span>
        </label>

        <label
          className="flex items-start gap-3 cursor-pointer"
          htmlFor="mail-dispatch-mode-both"
          aria-label="App und n8n-Event parallel"
        >
          <input
            id="mail-dispatch-mode-both"
            type="radio"
            name="mode"
            value="BOTH"
            defaultChecked={initial.mode === 'BOTH'}
            className="mt-1 h-4 w-4 text-brand-600 border-strong focus:ring-focus"
          />
          <span>
            <span className="block text-sm font-medium text-primary">App + n8n-Event parallel</span>
            <span className="block text-xs text-secondary dark:text-disabled">
              Die App verschickt die Mail wie oben — zusätzlich wird ein signierter Webhook an n8n
              geschickt, damit dort weitere Aktionen folgen können (Slack-Ping ans Team, CRM-Sync,
              externe Eskalation). n8n übernimmt NICHT den Mail-Versand. Voraussetzung: unter
              „n8n-Automatisierung“ ist eine aktive Event-Route eingerichtet.
            </span>
          </span>
        </label>
      </fieldset>

      <div className="flex items-center gap-3 pt-2">
        <button type="submit" className="btn-primary" disabled={isPending}>
          {isPending ? 'Speichere…' : 'Speichern'}
        </button>
        {state?.ok && (
          <span className="text-sm text-emerald-700" role="status">
            Gespeichert.
          </span>
        )}
        {state && !state.ok && (
          <span className="text-sm text-red-700" role="alert">
            {state.error}
          </span>
        )}
      </div>
    </form>
  );
}
