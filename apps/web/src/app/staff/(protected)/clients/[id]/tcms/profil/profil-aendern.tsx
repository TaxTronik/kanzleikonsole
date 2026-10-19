'use client';

// „Profil ändern“ (TCMS Stufe 3, Bereich A; aus der Demo
// components/profil/profil-aktionen.tsx): neuer Profilstand mit Gültig-ab-Datum
// auf dem gesehenen offenen Stand. Fehler bleiben im Formular stehen; nach
// Erfolg leitet die Aktion zur Historie weiter.
import Link from 'next/link';
import { startTransition, useActionState, useId, useState, type FormEvent } from 'react';
import { Save } from 'lucide-react';
import type { Geschaeftsprofil } from '@taxtronik/tcms-domain';
import { FieldError, fieldErrorProps, FormErrorSummary } from '@/components/form-errors';
import type { TcmsAktionsErgebnis } from '@/components/tcms/programm/dialog';
import { ProfilFormular, type ProfilPerson } from '@/components/tcms/programm/profil-formular';
import { profilAendernAction } from './actions';

export function ProfilAendernFormular({
  mandantId,
  profilStandId,
  start,
  personen,
  heuteIso,
  abbrechenHref,
}: {
  mandantId: string;
  /** Offener Stand, auf dem die Änderung beruht (sonst Konflikt im Dienst). */
  profilStandId: string;
  start: Geschaeftsprofil;
  personen: readonly ProfilPerson[];
  heuteIso: string;
  abbrechenHref: string;
}) {
  const id = useId();
  const [profil, setProfil] = useState(start);
  const [ergebnis, aktion, laeuft] = useActionState<TcmsAktionsErgebnis | null, FormData>(
    profilAendernAction.bind(null, mandantId),
    null,
  );
  const fe = ergebnis && !ergebnis.ok ? ergebnis.fieldErrors : undefined;

  // Eigener Submit: Reacts Formular-Action setzte sonst Datum und Haken auch
  // nach einer Ablehnung zurück (vgl. components/action-form.tsx).
  function absenden(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (laeuft) return;
    const formData = new FormData(event.currentTarget);
    startTransition(() => aktion(formData));
  }

  return (
    <form action={aktion} onSubmit={absenden} aria-busy={laeuft || undefined}>
      <input type="hidden" name="profilStandId" value={profilStandId} />
      <input type="hidden" name="profil" value={JSON.stringify(profil)} />
      <div className="p-4 space-y-4">
        {ergebnis && !ergebnis.ok ? (
          <FormErrorSummary
            title="Der Profilstand wurde nicht angelegt."
            {...(ergebnis.error ? { error: ergebnis.error } : {})}
            {...(fe ? { fieldErrors: fe } : {})}
            fieldIds={{ gueltigAb: `${id}-gueltig-ab` }}
          />
        ) : null}
        <ProfilFormular
          wert={profil}
          onChange={setProfil}
          personen={personen}
          heuteIso={heuteIso}
        />
        <FieldError name="profil" errors={fe?.['profil']} prefix={id} />
        <div className="flex flex-wrap items-end gap-6">
          <div>
            <label className="label-sm" htmlFor={`${id}-gueltig-ab`}>
              Gültig ab
            </label>
            <input
              id={`${id}-gueltig-ab`}
              name="gueltigAb"
              type="date"
              className="input w-auto"
              min={heuteIso}
              defaultValue={heuteIso}
              required
              {...fieldErrorProps('gueltigAb', fe, { prefix: id })}
            />
            <FieldError name="gueltigAb" errors={fe?.['gueltigAb']} prefix={id} />
          </div>
          <label className="inline-flex items-center gap-2 text-sm pb-2">
            <input type="checkbox" name="ereignisse" defaultChecked />
            Ereignisse im Ereigniseingang anlegen
          </label>
        </div>
        <p className="hint">
          Der bisherige Stand wird zum Gültig-ab-Datum geschlossen, ein neuer Stand angelegt;
          frühere Stände bleiben unverändert. Je geänderter Profilfrage entsteht das Ereignis laut
          Fachkonzept (z. B. P2 → T-02). Risiken, deren Grundlage sich ändert, werden zur
          Neubewertung markiert. Abwählen, wenn die Änderung aus einem bereits erfassten Ereignis
          stammt.
        </p>
      </div>
      <div className="form-actions border-t border-default px-4 py-3 flex justify-end gap-2">
        <Link href={abbrechenHref} className="btn-secondary">
          Abbrechen
        </Link>
        <button type="submit" className="btn-primary" disabled={laeuft} aria-busy={laeuft}>
          <Save className="h-4 w-4" aria-hidden="true" />{' '}
          {laeuft ? 'Wird angelegt …' : 'Neuen Profilstand anlegen'}
        </button>
      </div>
    </form>
  );
}
