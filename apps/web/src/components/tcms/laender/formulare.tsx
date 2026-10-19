'use client';

// =============================================================================
// Formulare des Länder-Monitors (TCMS Stufe 3, portiert aus der Demo
// components/laender/formulare.tsx): neuer Stand eines Landes (Detailbereich),
// Sammelerfassung aller Länder zu einem Stand, Land aufnehmen. Beträge dürfen
// in deutscher Schreibweise eingegeben werden; geprüft wird in der Aktion und
// im Dienst. Ergebnis als feste Meldung bzw. Fehlerzusammenfassung.
// =============================================================================

import Link from 'next/link';
import { useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { Plus, Save } from 'lucide-react';
import { LAND_NAME } from '@taxtronik/tcms-domain';
import { FieldError, fieldErrorProps, FormErrorSummary } from '@/components/form-errors';
import type { TcmsAktion, TcmsAktionsErgebnis } from '../bereich-b/ergebnis';
import { useTcmsFormular } from '../bereich-b/formular';

/** Ergebnis von „Land hinzufügen“: mit dem aufgenommenen Land für den Link. */
export type LandHinzufuegenErgebnis = TcmsAktionsErgebnis & { land?: string };
export type LandHinzufuegenAktion = (
  vorher: LandHinzufuegenErgebnis | null,
  formData: FormData,
) => Promise<LandHinzufuegenErgebnis>;

export interface LandWerte {
  land: string;
  fernverkaeufeLfdEur: number;
  fernverkaeufeVorjahrEur: number;
  lagerSeit: string | null;
  oss: boolean;
  lokaleUstNr: boolean;
  zmRelevant: boolean;
  steuersaetzeGeprueftAm: string | null;
  /** Stand des letzten Eintrags (`YYYY-MM-DD`) – frühester sinnvoller Datenstand. */
  stand?: string | null;
}

type Fehler = Record<string, string[]> | undefined;

/** Betrag für ein Textfeld in deutscher Schreibweise (ohne Tausenderpunkte). */
function betragText(n: number): string {
  return n.toLocaleString('de-DE', { maximumFractionDigits: 2, useGrouping: false });
}

function Ergebnis({ ergebnis, titel }: { ergebnis: TcmsAktionsErgebnis | null; titel: string }) {
  if (!ergebnis) return null;
  if (!ergebnis.ok) {
    return (
      <FormErrorSummary
        title={titel}
        {...(ergebnis.error ? { error: ergebnis.error } : {})}
        {...(ergebnis.fieldErrors ? { fieldErrors: ergebnis.fieldErrors } : {})}
      />
    );
  }
  return (
    <p className="alert-success-sm" role="status">
      {ergebnis.meldung}
    </p>
  );
}

function TextFeld({
  id,
  name,
  label,
  fehler,
  hinweis,
  ...input
}: {
  id: string;
  name: string;
  label: string;
  fehler: Fehler;
  hinweis?: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'name'>) {
  const hinweisId = hinweis ? `${id}-${name}-hinweis` : undefined;
  return (
    <div>
      <label htmlFor={`${id}-${name}`} className="label-sm">
        {label}
      </label>
      <input
        id={`${id}-${name}`}
        name={name}
        className="input"
        {...input}
        {...fieldErrorProps(name, fehler, {
          prefix: id,
          ...(hinweisId ? { describedBy: hinweisId } : {}),
        })}
      />
      {hinweis ? (
        <p id={hinweisId} className="hint">
          {hinweis}
        </p>
      ) : null}
      <FieldError name={name} errors={fehler?.[name]} prefix={id} />
    </div>
  );
}

function Haken({ id, name, label, an }: { id: string; name: string; label: string; an: boolean }) {
  return (
    <label className="inline-flex items-center gap-2 text-sm" htmlFor={`${id}-${name}`}>
      <input id={`${id}-${name}`} type="checkbox" name={name} value="on" defaultChecked={an} />
      {label}
    </label>
  );
}

/** Felder eines Landes; `praefix` für die Sammelerfassung (`CZ.`). */
function LandFelder({
  id,
  w,
  heute,
  fehler,
  praefix = '',
}: {
  id: string;
  w: Omit<LandWerte, 'land'>;
  heute: string;
  fehler: Fehler;
  praefix?: string;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <TextFeld
        id={id}
        name={`${praefix}fernverkaeufeLfdEur`}
        label="Fernverkäufe lfd. Jahr (€)"
        inputMode="decimal"
        defaultValue={betragText(w.fernverkaeufeLfdEur)}
        fehler={fehler}
        required
      />
      <TextFeld
        id={id}
        name={`${praefix}fernverkaeufeVorjahrEur`}
        label="Fernverkäufe Vorjahr (€)"
        inputMode="decimal"
        defaultValue={betragText(w.fernverkaeufeVorjahrEur)}
        fehler={fehler}
        required
      />
      <TextFeld
        id={id}
        name={`${praefix}lagerSeit`}
        label="Lager seit (Monat)"
        type="month"
        defaultValue={w.lagerSeit ?? ''}
        hinweis="leer = kein Lager im Land"
        fehler={fehler}
      />
      <TextFeld
        id={id}
        name={`${praefix}steuersaetzeGeprueftAm`}
        label="Steuersätze geprüft am"
        type="date"
        max={heute}
        defaultValue={w.steuersaetzeGeprueftAm ?? ''}
        fehler={fehler}
      />
      <fieldset className="sm:col-span-2 flex flex-wrap gap-x-5 gap-y-1">
        <legend className="sr-only">Merkmale</legend>
        <Haken id={id} name={`${praefix}oss`} label="OSS" an={w.oss} />
        <Haken
          id={id}
          name={`${praefix}lokaleUstNr`}
          label="lokale USt-Nr. erteilt"
          an={w.lokaleUstNr}
        />
        <Haken
          id={id}
          name={`${praefix}zmRelevant`}
          label="ZM-relevante Bewegungen"
          an={w.zmRelevant}
        />
      </fieldset>
    </div>
  );
}

function SpeichernKnopf({ laeuft, children }: { laeuft: boolean; children: ReactNode }) {
  return (
    <button type="submit" className="btn-primary" disabled={laeuft} aria-busy={laeuft}>
      {laeuft ? 'Wird gespeichert …' : children}
    </button>
  );
}

/** Neuer Stand für ein Land (Detailbereich). */
export function LandStandFormular({
  aktion,
  land,
  heute,
}: {
  aktion: TcmsAktion;
  land: LandWerte;
  heute: string;
}) {
  const id = useId();
  const { ergebnis, laeuft, formular } = useTcmsFormular(aktion);
  const fehler = ergebnis && !ergebnis.ok ? ergebnis.fieldErrors : undefined;
  return (
    <form {...formular} className="space-y-3" aria-label={`Neuen Stand für ${land.land} erfassen`}>
      <input type="hidden" name="land" value={land.land} />
      <Ergebnis ergebnis={ergebnis} titel="Stand nicht gespeichert." />
      <TextFeld
        id={id}
        name="datenstand"
        label="Stand (Datum der Daten)"
        type="date"
        max={heute}
        {...(land.stand ? { min: land.stand } : {})}
        defaultValue={heute}
        required
        fehler={fehler}
      />
      <LandFelder id={id} w={land} heute={heute} fehler={fehler} />
      <div className="form-actions items-center justify-between">
        <span className="text-xs text-muted">
          Der bisherige Stand bleibt unverändert in der Historie.
        </span>
        <SpeichernKnopf laeuft={laeuft}>
          <Save className="h-4 w-4" aria-hidden="true" /> Neuen Stand speichern
        </SpeichernKnopf>
      </div>
    </form>
  );
}

/** Sammelerfassung: alle Länder des Monitors zu einem Stand. */
export function SammelErfassung({
  aktion,
  laender,
  heute,
  zurueck,
}: {
  aktion: TcmsAktion;
  laender: readonly LandWerte[];
  heute: string;
  zurueck: string;
}) {
  const id = useId();
  const { ergebnis, laeuft, formular } = useTcmsFormular(aktion);
  const fehler = ergebnis && !ergebnis.ok ? ergebnis.fieldErrors : undefined;
  return (
    <form {...formular} className="card mt-4" aria-labelledby={`${id}-titel`}>
      <input type="hidden" name="sammel" value="1" />
      <div className="card-header flex-wrap gap-3">
        <h3 id={`${id}-titel`} className="text-sm font-semibold text-primary">
          Länderdaten erfassen
        </h3>
        <div className="w-48">
          <TextFeld
            id={id}
            name="datenstand"
            label="Stand (Datum der Daten)"
            type="date"
            max={heute}
            defaultValue={heute}
            required
            fehler={fehler}
          />
        </div>
      </div>
      <div className="px-4 pt-3">
        <Ergebnis ergebnis={ergebnis} titel="Länderstände nicht gespeichert." />
      </div>
      <div className="p-4 space-y-4">
        {laender.map((l) => (
          <fieldset
            key={l.land}
            className="border-t border-default pt-3 first:border-t-0 first:pt-0"
          >
            <legend className="text-sm font-semibold text-primary">
              {l.land} · {LAND_NAME[l.land] ?? l.land}
            </legend>
            <input type="hidden" name="land" value={l.land} />
            <LandFelder
              id={`${id}-${l.land}`}
              w={l}
              heute={heute}
              fehler={fehler}
              praefix={`${l.land}.`}
            />
          </fieldset>
        ))}
      </div>
      <div className="card-footer flex-wrap gap-3">
        <span>
          Je Land entsteht ein neuer Stand; frühere Stände bleiben erhalten. Ein neu erfasstes Lager
          legt im Tax-CMS ein Ereignis an.
        </span>
        <span className="inline-flex gap-2">
          <Link href={zurueck} className="btn-secondary">
            Abbrechen
          </Link>
          <SpeichernKnopf laeuft={laeuft}>
            <Save className="h-4 w-4" aria-hidden="true" /> Alle Stände speichern
          </SpeichernKnopf>
        </span>
      </div>
    </form>
  );
}

/** Weiteres Land in den Monitor aufnehmen (Auswahl: EU-Länder ohne DE und ohne vorhandene). */
export function LandHinzufuegenFormular({
  aktion,
  frei,
  heute,
  landHref,
}: {
  aktion: LandHinzufuegenAktion;
  frei: readonly string[];
  heute: string;
  /** Link auf den Detailbereich eines Landes, `{land}` wird ersetzt. */
  landHref: string;
}) {
  const id = useId();
  const { ergebnis, laeuft, formular } = useTcmsFormular(aktion);
  const fehler = ergebnis && !ergebnis.ok ? ergebnis.fieldErrors : undefined;
  return (
    <section className="card mt-4" id="land-neu" aria-labelledby={`${id}-titel`}>
      <div className="card-header">
        <h3 id={`${id}-titel`} className="text-sm font-semibold text-primary">
          Land hinzufügen
        </h3>
        <span className="text-xs text-muted">{frei.length} EU-Länder noch nicht im Monitor</span>
      </div>
      <form {...formular} className="p-4 space-y-3">
        <Ergebnis ergebnis={ergebnis} titel="Land nicht aufgenommen." />
        {ergebnis?.ok && ergebnis.land ? (
          <Link className="underline text-sm" href={landHref.replace('{land}', ergebnis.land)}>
            {ergebnis.land} öffnen
          </Link>
        ) : null}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor={`${id}-land`} className="label-sm">
              Land
            </label>
            <select
              id={`${id}-land`}
              name="land"
              className="input"
              required
              defaultValue=""
              {...fieldErrorProps('land', fehler, { prefix: id })}
            >
              <option value="" disabled>
                Land wählen …
              </option>
              {frei.map((l) => (
                <option key={l} value={l}>
                  {l} · {LAND_NAME[l] ?? l}
                </option>
              ))}
            </select>
            <FieldError name="land" errors={fehler?.land} prefix={id} />
          </div>
          <TextFeld
            id={id}
            name="datenstand"
            label="Stand (Datum der Daten)"
            type="date"
            max={heute}
            defaultValue={heute}
            required
            fehler={fehler}
          />
        </div>
        <LandFelder
          id={id}
          w={{
            fernverkaeufeLfdEur: 0,
            fernverkaeufeVorjahrEur: 0,
            lagerSeit: null,
            oss: true,
            lokaleUstNr: false,
            zmRelevant: false,
            steuersaetzeGeprueftAm: null,
          }}
          heute={heute}
          fehler={fehler}
        />
        <div className="form-actions">
          <button
            type="submit"
            className="btn-primary"
            disabled={laeuft || frei.length === 0}
            aria-busy={laeuft}
          >
            <Plus className="h-4 w-4" aria-hidden="true" /> Land aufnehmen
          </button>
        </div>
      </form>
    </section>
  );
}
