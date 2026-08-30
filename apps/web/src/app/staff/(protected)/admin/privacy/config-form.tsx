'use client';

import { useActionState } from 'react';
import type { ActionResult } from '@/server/actions/types';
import type { PrivacyConfig } from '@/server/privacy/notice';
import { savePrivacyConfigAction } from './actions';

export function PrivacyConfigForm({ initial }: { initial: PrivacyConfig }) {
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    savePrivacyConfigAction,
    null,
  );

  return (
    <form action={formAction} className="card p-6 space-y-4">
      <div>
        <label className="label-sm" htmlFor="privacy-responsible-body">
          Verantwortliche Stelle *
        </label>
        <textarea
          id="privacy-responsible-body"
          name="responsibleBody"
          rows={3}
          maxLength={2000}
          defaultValue={initial.responsibleBody}
          placeholder="Name der Kanzlei / Steuerberatungsgesellschaft, Anschrift, Telefon, E-Mail"
          className="input w-full text-sm"
          aria-describedby="privacy-responsible-body-hint"
        />
        <p id="privacy-responsible-body-hint" className="text-xs text-muted mt-1">
          Name, ladungsfähige Anschrift sowie E-Mail oder Telefon vollständig angeben.
        </p>
      </div>
      <div>
        <label className="label-sm" htmlFor="privacy-dpo-contact">
          Datenschutzbeauftragte/r
        </label>
        <input
          id="privacy-dpo-contact"
          name="dpoContact"
          maxLength={1000}
          defaultValue={initial.dpoContact}
          placeholder="Name und Kontakt, sonst: nicht benannt"
          className="input w-full text-sm"
        />
      </div>
      <div>
        <label className="label-sm" htmlFor="privacy-supervisory-authority">
          Zuständige Aufsichtsbehörde *
        </label>
        <textarea
          id="privacy-supervisory-authority"
          name="supervisoryAuthority"
          rows={2}
          maxLength={1000}
          defaultValue={initial.supervisoryAuthority}
          placeholder="Name und Anschrift der Datenschutzaufsichtsbehörde"
          className="input w-full text-sm"
        />
      </div>
      <div>
        <label className="label-sm" htmlFor="privacy-contact">
          Datenschutz-/Widerrufskontakt der Kanzlei *
        </label>
        <input
          id="privacy-contact"
          name="privacyContact"
          maxLength={1000}
          defaultValue={initial.privacyContact}
          placeholder="E-Mail / Anschrift für Betroffenenrechte und Widerruf"
          className="input w-full text-sm"
        />
      </div>
      <div>
        <label className="label-sm" htmlFor="privacy-third-country-services">
          Dienste mit Drittlandbezug
        </label>
        <input
          id="privacy-third-country-services"
          name="drittlandServices"
          maxLength={2000}
          defaultValue={initial.drittlandServices}
          placeholder="Konkrete Dienste außerhalb EU/EWR, sonst: keine"
          className="input w-full text-sm"
        />
      </div>

      {state && !state.ok && state.error && (
        <div
          className="rounded-md bg-red-50 dark:bg-red-950/40 p-3 text-sm text-red-700 dark:text-red-300"
          role="alert"
        >
          {state.error}
        </div>
      )}
      {state?.ok && (
        <div
          className="rounded-md bg-green-50 dark:bg-green-950/40 p-3 text-sm text-green-700 dark:text-green-300"
          role="status"
        >
          Kanzlei-Datenschutzangaben gespeichert.
        </div>
      )}

      <div className="flex justify-end">
        <button type="submit" className="btn-primary" disabled={isPending}>
          {isPending ? 'Speichert…' : 'Speichern'}
        </button>
      </div>
    </form>
  );
}
