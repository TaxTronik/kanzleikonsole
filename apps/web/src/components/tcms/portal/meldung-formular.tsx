'use client';

// =============================================================================
// Ereignis melden im Portal (TCMS Stufe 3, Bereich D; aus der Demo
// components/ereignisse/portal-formular.tsx): Kacheln je Ereignistyp, kurzes
// Formular, Anlagen, Absenden (Sie-Form). Der Fortschritt ist reine
// Bedienhilfe; die Mindestlängen kommen aus dem Vertrag (über Props), prüfen
// tun Aktion und Tax-CMS. Wer nicht melden darf (Antwort des Dienstes), sieht
// das Formular gesperrt mit Hinweis.
// =============================================================================

import { useId, useState } from 'react';
import Link from 'next/link';
import { Check, Send } from 'lucide-react';
import { FieldError, fieldErrorProps } from '@/components/form-errors';
import { KatalogIcon } from '../icon';
import { tonChip } from '../ton';
import { TcmsErgebnisMeldung, useTcmsAbsenden, type TcmsFormAktion } from '../ereignisse/aktionen';
import type { MeldeKachel } from '../ereignisse/texte';
import { auswahlProblem } from './anlagen-upload';
import { fmtGroesse } from '../durchfuehrung/werte';

/** Warum noch nicht gesendet werden kann (Bedienhilfe), sonst null. */
function sperrGrund(z: {
  darf: boolean;
  sperrHinweis: string | null;
  problem: string | null;
  bereit: boolean;
}): string | null {
  if (!z.darf) return z.sperrHinweis;
  if (z.problem) return z.problem;
  return z.bereit ? null : 'Bitte wählen Sie die Art und füllen Sie die Details aus.';
}

/** Fortschritt der Eingabe (reine Bedienhilfe). */
function Fortschritt({ schritte }: { schritte: ReadonlyArray<readonly [string, boolean]> }) {
  return (
    <ol className="flex flex-wrap gap-4 text-sm" aria-label="Fortschritt">
      {schritte.map(([text, ok], i) => (
        <li key={text} className="inline-flex items-center gap-1.5">
          <span className={`kpi-chip ${ok ? 'chip-green' : 'chip-gray'}`} aria-hidden="true">
            {ok ? <Check className="h-3 w-3" /> : i + 1}
          </span>
          {text}
          <span className="sr-only">{ok ? ' (erledigt)' : ' (offen)'}</span>
        </li>
      ))}
    </ol>
  );
}

/** Anlagen der Meldung (nur wenn Portal-Uploads freigeschaltet sind). */
function AnlagenFeld({
  id,
  accept,
  hinweis,
  dateien,
  setDateien,
  fehler,
}: {
  id: string;
  accept: string;
  hinweis: string;
  dateien: ReadonlyArray<{ name: string; size: number }>;
  setDateien: (dateien: Array<{ name: string; size: number }>) => void;
  fehler: Record<string, string[]> | undefined;
}) {
  return (
    <div>
      <label htmlFor={`${id}-anlagen`} className="label-sm">
        Anlagen (optional)
      </label>
      <input
        id={`${id}-anlagen`}
        type="file"
        name="anlagen"
        multiple
        accept={accept}
        className="block text-sm"
        onChange={(e) =>
          setDateien(Array.from(e.target.files ?? []).map((f) => ({ name: f.name, size: f.size })))
        }
        {...fieldErrorProps('anlagen', fehler, {
          prefix: id,
          describedBy: `${id}-anlagen-hinweis`,
        })}
      />
      <p id={`${id}-anlagen-hinweis`} className="hint">
        {hinweis}
      </p>
      {dateien.length ? (
        <p className="text-xs text-secondary mt-1">
          {dateien.map((d) => `${d.name} (${fmtGroesse(d.size)})`).join(' · ')}
        </p>
      ) : null}
      <FieldError name="anlagen" errors={fehler?.['anlagen']} prefix={id} />
    </div>
  );
}

export function MeldungFormular({
  aktion,
  kacheln,
  heute,
  darf,
  sperrHinweis,
  upload,
  grenzen,
  accept,
  uploadHinweis,
}: {
  aktion: TcmsFormAktion;
  kacheln: readonly MeldeKachel[];
  heute: string;
  darf: boolean;
  sperrHinweis: string | null;
  /** Portal-Uploads in der Kanzlei freigeschaltet. */
  upload: boolean;
  grenzen: {
    maxDateien: number;
    maxBytes: number;
    maxGesamt: number;
    minTitel: number;
    minBeschreibung: number;
  };
  accept: string;
  uploadHinweis: string;
}) {
  const id = useId();
  const { ergebnis, laeuft, onSubmit } = useTcmsAbsenden(aktion);
  const [typ, setTyp] = useState<string | null>(null);
  const [titel, setTitel] = useState('');
  const [beschreibung, setBeschreibung] = useState('');
  const [datum, setDatum] = useState(heute);
  const [dateien, setDateien] = useState<Array<{ name: string; size: number }>>([]);
  const fieldErrors = ergebnis && !ergebnis.ok ? ergebnis.fieldErrors : undefined;

  const artOk = typ !== null;
  const detailsOk =
    titel.trim().length >= grenzen.minTitel &&
    beschreibung.trim().length >= grenzen.minBeschreibung &&
    datum !== '';
  const bereit = artOk && detailsOk;
  const problem = auswahlProblem(dateien, grenzen);
  const gewaehlt = kacheln.find((k) => k.code === typ);
  const grund = sperrGrund({ darf, sperrHinweis, problem, bereit });

  return (
    <form onSubmit={onSubmit} className="space-y-4" aria-label="Ereignis melden">
      <fieldset disabled={!darf || laeuft} className="space-y-4 min-w-0">
        <section className="card" aria-labelledby={`${id}-art`}>
          <div className="card-header">
            <h2 id={`${id}-art`} className="text-sm font-semibold text-primary">
              1 · Art des Ereignisses
            </h2>
            {gewaehlt ? <span className="badge-brand">{gewaehlt.label}</span> : null}
          </div>
          <div
            className="p-4 grid gap-3 grid-cols-[repeat(auto-fill,minmax(9rem,1fr))]"
            role="radiogroup"
            aria-labelledby={`${id}-art`}
            {...fieldErrorProps('typ', fieldErrors, { prefix: id })}
          >
            {kacheln.map((k) => {
              const aktiv = typ === k.code;
              return (
                <label
                  key={k.code}
                  className={`card p-3 text-center cursor-pointer focus-within:ring-2 focus-within:ring-focus ${
                    aktiv ? 'border-brand-600 bg-surface-sunken' : ''
                  }`}
                >
                  <input
                    type="radio"
                    name="typ"
                    value={k.code}
                    checked={aktiv}
                    onChange={() => setTyp(k.code)}
                    className="sr-only"
                  />
                  <span className={`kpi-chip ${tonChip(k.ton)} mx-auto mb-2`}>
                    <KatalogIcon name={k.icon} />
                  </span>
                  <span className={`block text-xs ${aktiv ? 'font-bold' : 'font-medium'}`}>
                    {k.label}
                  </span>
                </label>
              );
            })}
          </div>
          <div className="px-4 pb-3">
            <FieldError name="typ" errors={fieldErrors?.['typ']} prefix={id} />
          </div>
        </section>

        <section className="card" aria-labelledby={`${id}-details`}>
          <div className="card-header">
            <h2 id={`${id}-details`} className="text-sm font-semibold text-primary">
              2 · Details
            </h2>
          </div>
          <div className="p-4 space-y-4">
            <div>
              <label htmlFor={`${id}-datum`} className="label-sm">
                Datum (seit wann bzw. ab wann gilt die Änderung?)
              </label>
              <input
                id={`${id}-datum`}
                type="date"
                name="datum"
                className="input w-auto"
                value={datum}
                onChange={(e) => setDatum(e.target.value)}
                required
                {...fieldErrorProps('datum', fieldErrors, { prefix: id })}
              />
              <FieldError name="datum" errors={fieldErrors?.['datum']} prefix={id} />
            </div>
            <div>
              <label htmlFor={`${id}-titel`} className="label-sm">
                Bezeichnung
              </label>
              <input
                id={`${id}-titel`}
                name="titel"
                className="input"
                placeholder="z. B. Outdoor-Kochbücher ab 11/2026"
                value={titel}
                onChange={(e) => setTitel(e.target.value)}
                required
                minLength={grenzen.minTitel}
                maxLength={200}
                {...fieldErrorProps('titel', fieldErrors, { prefix: id })}
              />
              <FieldError name="titel" errors={fieldErrors?.['titel']} prefix={id} />
            </div>
            <div>
              <label htmlFor={`${id}-beschreibung`} className="label-sm">
                Beschreibung
              </label>
              <textarea
                id={`${id}-beschreibung`}
                name="beschreibung"
                className="input min-h-[6rem]"
                placeholder="z. B. Wir verkaufen ab November zusätzlich Kochbücher über den eigenen Shop …"
                value={beschreibung}
                onChange={(e) => setBeschreibung(e.target.value)}
                required
                minLength={grenzen.minBeschreibung}
                maxLength={4000}
                {...fieldErrorProps('beschreibung', fieldErrors, {
                  prefix: id,
                  describedBy: `${id}-beschreibung-hinweis`,
                })}
              />
              <p id={`${id}-beschreibung-hinweis`} className="hint">
                Was ändert sich? Ab wann? Schätzung der Größenordnung, wenn bekannt.
              </p>
              <FieldError name="beschreibung" errors={fieldErrors?.['beschreibung']} prefix={id} />
            </div>
            {upload ? (
              <AnlagenFeld
                id={id}
                accept={accept}
                hinweis={uploadHinweis}
                dateien={dateien}
                setDateien={setDateien}
                fehler={fieldErrors}
              />
            ) : (
              <p className="hint">
                Anlagen können Sie im Portal Ihrer Kanzlei derzeit nicht hochladen.
              </p>
            )}
          </div>
        </section>

        <section className="card" aria-labelledby={`${id}-senden`}>
          <div className="card-header">
            <h2 id={`${id}-senden`} className="text-sm font-semibold text-primary">
              3 · Senden
            </h2>
          </div>
          <div className="p-4 space-y-4">
            <Fortschritt
              schritte={[
                ['Art gewählt', artOk],
                ['Details ausgefüllt', detailsOk],
                ['Abgabe bereit', bereit],
              ]}
            />
            <label className="inline-flex items-start gap-2 text-sm">
              <input type="checkbox" name="zusage" value="1" className="mt-1" />
              Ich informiere die Kanzlei zeitnah, wenn sich an diesen Angaben etwas ändert.
            </label>
            <TcmsErgebnisMeldung ergebnis={ergebnis} titel="Die Meldung wurde nicht gesendet." />
            <div className="form-actions">
              <Link href="/portal/tcms" className="btn-secondary">
                Abbrechen
              </Link>
              <button
                type="submit"
                className="btn-primary"
                disabled={grund !== null || laeuft}
                aria-busy={laeuft}
                aria-describedby={grund ? `${id}-grund` : undefined}
              >
                <Send className="h-4 w-4" aria-hidden="true" />{' '}
                {laeuft ? 'Wird gesendet …' : 'Ereignis melden'}
              </button>
            </div>
            {grund ? (
              <p id={`${id}-grund`} className="text-xs text-muted text-right">
                {grund}
              </p>
            ) : null}
          </div>
        </section>
      </fieldset>
    </form>
  );
}
