'use client';

import { useActionState } from 'react';
import { saveLegalAction, type ActionResult } from './actions';
import type { LegalLinks } from '@/server/settings/legal';

export function LegalForm({ initial }: { initial: LegalLinks }) {
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    saveLegalAction,
    null,
  );

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label className="label" htmlFor="legal-impressum">Impressum-URL</label>
        <input
          id="legal-impressum"
          name="impressumUrl"
          type="url"
          className="input"
          defaultValue={initial.impressumUrl}
          maxLength={500}
          placeholder="https://kanzlei-mueller.de/impressum"
        />
      </div>

      <div>
        <label className="label" htmlFor="legal-privacy">Datenschutzerklärung-URL</label>
        <input
          id="legal-privacy"
          name="privacyUrl"
          type="url"
          className="input"
          defaultValue={initial.privacyUrl}
          maxLength={500}
          placeholder="https://kanzlei-mueller.de/datenschutz"
        />
      </div>

      <p className="text-xs text-gray-500">
        Beide Links werden im Footer der Login-Seiten (Mitarbeiter + Mandantenportal)
        angezeigt — Pflicht nach Telemediengesetz und DSGVO. In angemeldeten
        Sitzungen werden die Links nicht prominent angezeigt.
      </p>

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
