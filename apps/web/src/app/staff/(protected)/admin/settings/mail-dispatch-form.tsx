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

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="radio"
            name="mode"
            value="APP"
            defaultChecked={initial.mode === 'APP'}
            className="mt-1 h-4 w-4 text-brand-600 border-gray-300 focus:ring-brand-500"
          />
          <div>
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
              Nur App-eigener Versand <span className="text-xs text-gray-500">(Default)</span>
            </p>
            <p className="text-xs text-gray-600 dark:text-gray-400">
              Alle Mails werden direkt über das SMTP-Modul mit den
              EmailTemplate-Vorlagen verschickt. n8n bleibt deaktiviert.
              Empfohlen für Kanzleien ohne externe Workflow-Engine.
            </p>
          </div>
        </label>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="radio"
            name="mode"
            value="BOTH"
            defaultChecked={initial.mode === 'BOTH'}
            className="mt-1 h-4 w-4 text-brand-600 border-gray-300 focus:ring-brand-500"
          />
          <div>
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
              App + n8n-Event parallel
            </p>
            <p className="text-xs text-gray-600 dark:text-gray-400">
              Die App verschickt die Mail wie oben — zusätzlich wird ein
              signierter Webhook an n8n geschickt, damit dort weitere
              Aktionen folgen können (Slack-Ping ans Team, CRM-Sync, externe
              Eskalation). n8n übernimmt NICHT den Mail-Versand. Voraussetzung:
              n8n-Bridge unten konfiguriert.
            </p>
          </div>
        </label>
      </fieldset>

      <div className="flex items-center gap-3 pt-2">
        <button type="submit" className="btn-primary" disabled={isPending}>
          {isPending ? 'Speichere…' : 'Speichern'}
        </button>
        {state?.ok && <span className="text-sm text-emerald-700">Gespeichert.</span>}
        {state && !state.ok && <span className="text-sm text-red-700">{state.error}</span>}
      </div>
    </form>
  );
}
