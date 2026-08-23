'use client';

import { useActionState } from 'react';
import { saveLetterheadAction, type ActionResult } from './actions';
import type { LetterheadConfig } from '@/server/settings/letterhead';

export function LetterheadForm({ initial }: { initial: LetterheadConfig }) {
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    saveLetterheadAction,
    null,
  );

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label className="label" htmlFor="lh-org">
          Kanzlei-Name
        </label>
        <input
          id="lh-org"
          name="organisationName"
          type="text"
          className="input"
          defaultValue={initial.organisationName}
          maxLength={200}
          placeholder="z. B. Steuerkanzlei Mustermann & Partner mbB"
        />
      </div>

      <div>
        <label className="label" htmlFor="lh-addr">
          Adresse (mehrzeilig)
        </label>
        <textarea
          id="lh-addr"
          name="addressLines"
          rows={4}
          maxLength={1000}
          className="input font-mono text-sm"
          defaultValue={initial.addressLines}
          placeholder={'Musterstraße 12\n12345 Musterstadt\nDeutschland'}
        />
      </div>

      <div>
        <label className="label" htmlFor="lh-contact">
          Kontakt-Zeile
        </label>
        <input
          id="lh-contact"
          name="contactLine"
          type="text"
          className="input"
          defaultValue={initial.contactLine}
          maxLength={500}
          placeholder="Tel. 030 123456 · Fax 030 123457 · kanzlei@example.de"
        />
      </div>

      <div>
        <label className="label" htmlFor="lh-foot">
          Fußnote
        </label>
        <textarea
          id="lh-foot"
          name="footnote"
          rows={3}
          maxLength={1000}
          className="input font-mono text-sm"
          defaultValue={initial.footnote}
          placeholder={
            'Steuerberaterkammer Berlin · USt-ID DE123456789\nGeschäftsführer Max Mustermann (Steuerberater)'
          }
        />
      </div>

      <p className="text-xs text-muted">
        Wird bei der erstmaligen Erzeugung von Rechnungs-PDFs eingebunden. Bereits archivierte
        Rechnungen sowie extern hochgeladene oder signierte PDFs bleiben unverändert. PNG-/JPEG-
        Logos stammen aus den Erscheinungsbild-Einstellungen; WebP und die Akzentfarbe werden
        derzeit nicht in die Rechnung übernommen.
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
