'use client';

// =============================================================================
// Abschnitt einer Beschreibungsversion im Entwurf bearbeiten (TCMS Stufe 3,
// Bereich A; aus der Demo components/beschreibung/editor.tsx). Freitextblöcke
// als Textfelder, Bausteine bleiben unveränderlich (nur entfernen oder einen
// weiteren einfügen). Der Aufbau beim Öffnen (`struktur`) ordnet Textfelder
// und Entfernen-Haken den Blöcken zu; Prüfung und Speichern übernimmt die
// Aktion bzw. der Dienst (nur Entwürfe sind änderbar).
// =============================================================================

import Link from 'next/link';
import {
  startTransition,
  useActionState,
  useId,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { Plus, Save } from 'lucide-react';
import type { BeschreibungAbschnitt } from '@taxtronik/tcms-contract';
import { BAUSTEIN_LABEL, type BausteinArt } from '@taxtronik/tcms-domain';
import { FieldError, fieldErrorProps, FormErrorSummary } from '@/components/form-errors';
import type { TcmsAktionsErgebnis } from '@/components/tcms/programm/dialog';
import { abschnittSpeichernAction } from './actions';
import { TCMS_TEXT_ISOLIERT } from '@/components/tcms/text';

export function AbschnittEditor({
  mandantId,
  versionId,
  abschnitt,
  titel,
  bausteine,
  fertigHref,
}: {
  mandantId: string;
  versionId: string;
  abschnitt: BeschreibungAbschnitt;
  titel: string;
  /** Darstellung der Bausteine (Server), in Reihenfolge der Blöcke vom Typ „baustein“. */
  bausteine: Readonly<Record<string, ReactNode>>;
  fertigHref: string;
}) {
  const id = useId();
  const [ergebnis, aktion, laeuft] = useActionState<TcmsAktionsErgebnis | null, FormData>(
    abschnittSpeichernAction.bind(null, mandantId),
    null,
  );
  const [neuerBaustein, setNeuerBaustein] = useState('');
  const fe = ergebnis && !ergebnis.ok ? ergebnis.fieldErrors : undefined;
  const vorhanden = new Set(
    abschnitt.bloecke.flatMap((b) => (b.typ === 'baustein' ? [b.art] : [])),
  );
  const frei = (Object.keys(BAUSTEIN_LABEL) as BausteinArt[]).filter((a) => !vorhanden.has(a));
  const textBloecke = abschnitt.bloecke.filter((b) => b.typ === 'text').length;
  const struktur = JSON.stringify(
    abschnitt.bloecke.map((b) =>
      b.typ === 'text' ? { typ: 'text' } : { typ: 'baustein', art: b.art },
    ),
  );

  // Eigener Submit: Reacts Formular-Action setzte sonst die Textfelder auch nach
  // einer Ablehnung zurück (vgl. components/action-form.tsx).
  function absenden(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (laeuft) return;
    const formData = new FormData(event.currentTarget);
    startTransition(() => {
      aktion(formData);
      setNeuerBaustein('');
    });
  }

  let textNr = 0;
  return (
    <form
      action={aktion}
      onSubmit={absenden}
      aria-label={`${titel} bearbeiten`}
      className="space-y-3"
    >
      <input type="hidden" name="versionId" value={versionId} />
      <input type="hidden" name="key" value={abschnitt.key} />
      <input type="hidden" name="struktur" value={struktur} />
      {ergebnis && !ergebnis.ok ? (
        <FormErrorSummary
          title="Der Abschnitt wurde nicht gespeichert."
          {...(ergebnis.error ? { error: ergebnis.error } : {})}
          {...(fe ? { fieldErrors: fe } : {})}
          fieldIds={{ neuerBaustein: `${id}-baustein`, text: `${id}-absatz-0` }}
        />
      ) : null}
      {ergebnis?.ok ? (
        <p className="alert-success-sm" role="status">
          {ergebnis.meldung ?? 'Abschnitt gespeichert.'}
        </p>
      ) : null}
      {textBloecke === 0 ? (
        <div>
          <label className="label-sm" htmlFor={`${id}-absatz-neu`}>
            Freitext
          </label>
          <textarea
            {...TCMS_TEXT_ISOLIERT}
            id={`${id}-absatz-neu`}
            name="textNeu"
            className="input"
            rows={6}
            maxLength={20_000}
            placeholder="Text dieses Abschnitts … (Absätze durch eine Leerzeile trennen)"
          />
        </div>
      ) : null}
      {abschnitt.bloecke.map((b, i) => {
        if (b.typ === 'text') {
          const nr = textNr++;
          return (
            <div key={`t-${nr}`}>
              <label className="label-sm" htmlFor={`${id}-absatz-${nr}`}>
                Freitext{textBloecke > 1 ? ` (Block ${nr + 1})` : ''}
              </label>
              <textarea
                {...TCMS_TEXT_ISOLIERT}
                id={`${id}-absatz-${nr}`}
                name="text"
                className="input"
                rows={Math.min(14, Math.max(5, Math.ceil(b.text.length / 90) + 1))}
                maxLength={20_000}
                defaultValue={b.text}
                placeholder="Text dieses Abschnitts … (Absätze durch eine Leerzeile trennen)"
                {...(nr === 0 ? fieldErrorProps('text', fe, { prefix: id }) : {})}
              />
              {nr === 0 ? <FieldError name="text" errors={fe?.['text']} prefix={id} /> : null}
            </div>
          );
        }
        return (
          <div key={`b-${b.art}`}>
            {bausteine[b.art] ?? null}
            <label className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted">
              <input type="checkbox" name="entfernen" value={String(i)} />
              Baustein „{BAUSTEIN_LABEL[b.art]}“ beim Speichern entfernen
            </label>
          </div>
        );
      })}
      <div className="flex flex-wrap items-end justify-between gap-3 pt-2">
        <div>
          <label className="label-sm inline-flex items-center gap-1" htmlFor={`${id}-baustein`}>
            <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Baustein einfügen
          </label>
          <select
            id={`${id}-baustein`}
            name="neuerBaustein"
            className="input w-auto py-1 text-xs"
            value={neuerBaustein}
            onChange={(e) => setNeuerBaustein(e.target.value)}
            {...fieldErrorProps('neuerBaustein', fe, { prefix: id })}
          >
            <option value="">—</option>
            {frei.map((a) => (
              <option key={a} value={a}>
                {BAUSTEIN_LABEL[a]}
              </option>
            ))}
          </select>
          <FieldError name="neuerBaustein" errors={fe?.['neuerBaustein']} prefix={id} />
        </div>
        <div className="flex gap-2">
          <Link href={fertigHref} className="btn-secondary">
            Fertig
          </Link>
          <button type="submit" className="btn-primary" disabled={laeuft} aria-busy={laeuft}>
            <Save className="h-4 w-4" aria-hidden="true" />{' '}
            {laeuft ? 'Wird gespeichert …' : 'Abschnitt speichern'}
          </button>
        </div>
      </div>
    </form>
  );
}
