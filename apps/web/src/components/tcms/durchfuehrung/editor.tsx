'use client';

// =============================================================================
// Hauptspalte einer Kontrolldurchführung (TCMS Stufe 3, Bereich C; portiert
// aus der Demo components/durchfuehrung/editor.tsx): Schritte, Toleranz, Werte,
// Ergebnis. Bearbeitbar nur, wenn der Dienst `rechte.bearbeiten` erlaubt (die
// Seite entscheidet über `bearbeitbar`), sonst schreibgeschützt mit dem Grund
// des Dienstes. Die Eingaben gehören über das `form`-Attribut zum
// Entwurfsformular in der Fußleiste; die Nachweis-Karte kommt als Slot.
// Differenzen, Abweichungen und Toleranzlage kommen aus der Prüfung des
// Dienstes (`pruefung.kennzahlen`, TCMS s7) für den gespeicherten Stand – der
// Browser rechnet nichts nach; ob eingereicht werden kann, prüft der Dienst.
// =============================================================================

import { useState, type ReactNode } from 'react';
import { fmtEur } from '@taxtronik/tcms-domain';
import {
  alsEingabe,
  LAGE_BADGE,
  LAGE_TEXT,
  parseDezimal,
  werteZeilen,
  type KennzahlDef,
  type KennzahlPruefung,
  type Werte,
  type WertZeile,
} from './werte';
import { TCMS_TEXT_ISOLIERT, TcmsText } from '@/components/tcms/text';

export interface EditorSchritt {
  titel: string;
  hinweis: string;
  erledigt: boolean;
  kommentar: string;
}

/** Lage eines Werts auf einer Skala um 0 mit Toleranzband (Text für Screenreader). */
function ToleranzSkala({
  wert,
  toleranz,
  erklaert,
}: {
  wert: number;
  toleranz: number;
  erklaert: boolean;
}) {
  const spanne = Math.max(toleranz * 10, Math.abs(wert) * 1.3, 1);
  const pos = (v: number) => Math.max(0, Math.min(100, 50 + (v / spanne) * 50));
  const innerhalb = Math.abs(wert) <= toleranz;
  const punkt = innerhalb ? 'dot-green' : erklaert ? 'dot-amber' : 'dot-red';
  return (
    <div className="mt-2">
      <div
        className="relative h-2 rounded-full bg-surface-sunken"
        role="img"
        aria-label={`Differenz ${fmtEur(wert)}, Toleranzband ±${fmtEur(toleranz)}`}
      >
        <span
          className="absolute top-0 h-2 bg-brand-100"
          style={{ left: `${pos(-toleranz)}%`, width: `${pos(toleranz) - pos(-toleranz)}%` }}
          aria-hidden="true"
        />
        <span
          className={`status-dot ${punkt} absolute -top-0.5 h-3 w-3 -translate-x-1/2`}
          style={{ left: `${pos(wert)}%` }}
          aria-hidden="true"
        />
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-muted" aria-hidden="true">
        <span>−{fmtEur(spanne)}</span>
        <span>0</span>
        <span>+{fmtEur(spanne)}</span>
      </div>
    </div>
  );
}

/** Eine Zeile der Werte-Tabelle (bearbeitbar oder schreibgeschützt). */
function WertTabellenZeile({
  z,
  formId,
  bearbeitbar,
  toleranzEur,
  eingabe,
  bemerkung,
  erklaert,
  setzeEingabe,
  setzeBemerkung,
  setzeErklaert,
}: {
  z: WertZeile;
  formId: string | undefined;
  bearbeitbar: boolean;
  toleranzEur: number | null;
  eingabe: string;
  bemerkung: string;
  erklaert: boolean;
  setzeEingabe: (wert: string) => void;
  setzeBemerkung: (wert: string) => void;
  setzeErklaert: (wert: boolean) => void;
}) {
  const differenz = z.def.differenzAus != null;
  const pruefbar = z.abweichung != null || differenz || z.def.sollEur != null;
  const eingebbar = bearbeitbar && !differenz;
  const unlesbar = eingebbar && parseDezimal(eingabe) === 'fehler';
  return (
    <tr className="border-t border-default align-top">
      <th
        scope="row"
        className={`px-6 py-3 text-left text-primary ${differenz ? 'font-medium' : 'font-normal'}`}
      >
        <TcmsText>{z.def.label}</TcmsText>
      </th>
      <td className={`td-num${differenz ? ' font-semibold' : ''}`}>
        {eingebbar ? (
          <input
            className="input w-32 py-1 text-right font-mono"
            name={`wert_${z.def.key}`}
            form={formId}
            inputMode="decimal"
            value={eingabe}
            onChange={(e) => setzeEingabe(e.target.value)}
            placeholder="0,00"
            aria-label={z.def.label}
            aria-invalid={unlesbar || undefined}
          />
        ) : (
          fmtEur(z.wert)
        )}
      </td>
      <td
        className={`td-num whitespace-nowrap${z.def.sollEur == null && !differenz ? ' text-muted' : ''}`}
      >
        {sollText(z, toleranzEur)}
      </td>
      <td className="px-6 py-3">
        {bearbeitbar ? (
          <div className="flex min-w-[14rem] flex-col gap-1">
            <input
              className="input py-1 text-sm"
              name={`bemerkung_${z.def.key}`}
              form={formId}
              value={bemerkung}
              onChange={(e) => setzeBemerkung(e.target.value)}
              placeholder={pruefbar ? 'Erläuterung der Abweichung' : 'Bemerkung (optional)'}
              aria-label={`Bemerkung ${z.def.label}`}
              maxLength={1000}
            />
            {pruefbar ? (
              <span className="flex flex-wrap items-center gap-2">
                <label className="inline-flex items-center gap-1.5 text-xs text-secondary">
                  <input
                    type="checkbox"
                    name={`erklaert_${z.def.key}`}
                    form={formId}
                    checked={erklaert}
                    onChange={(e) => setzeErklaert(e.target.checked)}
                  />
                  Abweichung erklärt
                  <span className="sr-only">
                    {' '}
                    (<TcmsText>{z.def.label}</TcmsText>)
                  </span>
                </label>
                {z.lage ? <span className={LAGE_BADGE[z.lage]}>{LAGE_TEXT[z.lage]}</span> : null}
              </span>
            ) : null}
          </div>
        ) : (
          <span className="flex flex-wrap items-center gap-2">
            {z.bemerkung ? <span>{z.bemerkung}</span> : <span className="text-muted">—</span>}
            {z.lage && z.lage !== 'OK' ? (
              <span className={LAGE_BADGE[z.lage]}>{LAGE_TEXT[z.lage]}</span>
            ) : null}
          </span>
        )}
      </td>
    </tr>
  );
}

function sollText(z: WertZeile, toleranzEur: number | null): string {
  if (z.def.differenzAus) {
    return toleranzEur != null ? `Toleranz ${fmtEur(toleranzEur)}` : 'Soll 0,00 €';
  }
  return z.def.sollEur != null ? fmtEur(z.def.sollEur) : '—';
}

export function DurchfuehrungEditor({
  formId,
  bearbeitbar,
  sperrGrund,
  schritte,
  kennzahlen,
  werte,
  pruefung,
  toleranzEur,
  periodeKurz,
  ergebnis,
  ergebnisKommentar,
  nachweise,
  ergebnisZusatz,
  minBefund,
}: {
  formId: string;
  bearbeitbar: boolean;
  sperrGrund?: string | null;
  schritte: EditorSchritt[];
  kennzahlen: KennzahlDef[];
  werte: Werte;
  /** Berechnete Werte des Dienstes für den gespeicherten Stand (`pruefung.kennzahlen`). */
  pruefung: readonly KennzahlPruefung[];
  toleranzEur: number | null;
  periodeKurz: string;
  ergebnis: 'OHNE_BEFUND' | 'MIT_BEFUND' | null;
  ergebnisKommentar: string | null;
  nachweise: ReactNode;
  ergebnisZusatz?: ReactNode;
  minBefund: number;
}) {
  const f = bearbeitbar ? formId : undefined;
  const titel = bearbeitbar ? undefined : (sperrGrund ?? undefined);
  const [erledigt, setErledigt] = useState(() => schritte.map((s) => s.erledigt));
  const [eingaben, setEingaben] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      kennzahlen.filter((k) => !k.differenzAus).map((k) => [k.key, alsEingabe(werte[k.key]?.wert)]),
    ),
  );
  const [bemerkungen, setBemerkungen] = useState<Record<string, string>>(() =>
    Object.fromEntries(kennzahlen.map((k) => [k.key, werte[k.key]?.bemerkung ?? ''])),
  );
  const [erklaert, setErklaert] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(kennzahlen.map((k) => [k.key, werte[k.key]?.erklaert ?? false])),
  );
  const [wahl, setWahl] = useState(ergebnis);

  // Werte, Differenzen und Lage des gespeicherten Stands laut Dienst.
  const zeilen = werteZeilen(kennzahlen, werte, pruefung);
  const anzahlErledigt = erledigt.filter(Boolean).length;
  const alleErledigt = schritte.length > 0 && anzahlErledigt === schritte.length;
  const differenzen = zeilen.filter(
    (z) => z.def.differenzAus && z.berechnet && z.wert != null && toleranzEur != null,
  );

  const schrittKarte = (
    <section className="card" aria-labelledby="df-schritte">
      <div className="card-header">
        <h3 id="df-schritte" className="text-sm font-semibold text-primary">
          Schritte &amp; Checkliste
        </h3>
        <span className={alleErledigt ? 'badge-green' : 'badge-gray'}>
          {anzahlErledigt} von {schritte.length}
        </span>
      </div>
      {schritte.length === 0 ? (
        <p className="px-6 py-4 text-sm text-muted">
          Für diese Kontrollversion sind keine Schritte hinterlegt.
        </p>
      ) : (
        <ol>
          {schritte.map((s, i) => (
            <li
              key={i}
              className="flex items-start gap-3 px-6 py-3 border-b border-default last:border-b-0"
            >
              <input
                type="checkbox"
                className="mt-1"
                id={`df-schritt-${i}`}
                name={`schritt_${i}_erledigt`}
                form={f}
                checked={erledigt[i] ?? false}
                disabled={!bearbeitbar}
                title={titel}
                onChange={(e) =>
                  setErledigt((a) => a.map((x, j) => (j === i ? e.target.checked : x)))
                }
              />
              <div className="grow min-w-0">
                <label
                  htmlFor={`df-schritt-${i}`}
                  className="block text-sm font-medium text-primary"
                >
                  {i + 1} · <TcmsText>{s.titel}</TcmsText>
                </label>
                <div className="text-xs text-muted mt-0.5">
                  <TcmsText>{s.hinweis}</TcmsText>
                </div>
                {bearbeitbar ? (
                  <input
                    className="input mt-2 py-1 text-xs"
                    name={`schritt_${i}_kommentar`}
                    form={f}
                    defaultValue={s.kommentar}
                    placeholder="Kommentar (optional)"
                    aria-label={`Kommentar zu Schritt ${i + 1}`}
                    maxLength={2000}
                  />
                ) : s.kommentar ? (
                  <div className="text-xs text-secondary mt-1">
                    Kommentar: <TcmsText>{s.kommentar}</TcmsText>
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );

  const toleranzKarten = differenzen.map((z) => {
    const a = kennzahlen.find((k) => k.key === z.def.differenzAus![0]);
    const b = kennzahlen.find((k) => k.key === z.def.differenzAus![1]);
    return (
      <div key={z.def.key} className="card px-6 py-4">
        <div className="text-xs font-semibold text-primary">
          <TcmsText>{z.def.label}</TcmsText>{' '}
          {a && b ? (
            <>
              <TcmsText>{a.label}</TcmsText> / <TcmsText>{b.label}</TcmsText>
            </>
          ) : (
            ''
          )}
          : <span className="font-mono">{fmtEur(z.wert)}</span> · Toleranz ±{fmtEur(toleranzEur)}
        </div>
        <ToleranzSkala
          wert={z.wert ?? 0}
          toleranz={toleranzEur ?? 0}
          erklaert={z.lage === 'ERKLAERT'}
        />
        <div className="text-xs text-muted mt-2">
          {z.lage === 'OK'
            ? 'innerhalb der Toleranz.'
            : z.lage === 'ERKLAERT'
              ? `außerhalb der Toleranz, erklärt: ${z.bemerkung}`
              : 'außerhalb der Toleranz und nicht erklärt.'}
        </div>
      </div>
    );
  });

  const werteKarte =
    kennzahlen.length > 0 ? (
      <section className="card" aria-labelledby="df-werte">
        <div className="card-header">
          <h3 id="df-werte" className="text-sm font-semibold text-primary">
            Werte &amp; Toleranz
          </h3>
          <span className="text-xs text-muted">Angaben der durchführenden Person</span>
        </div>
        <p className="hint px-6 pt-2">
          Differenzen und Toleranzlage berechnet das Tax-CMS für den gespeicherten Stand; nach
          Änderungen zuerst speichern.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th scope="col" className="th">
                  Kennzahl
                </th>
                <th scope="col" className="th th-right">
                  Wert <TcmsText>{periodeKurz}</TcmsText>
                </th>
                <th scope="col" className="th th-right">
                  Soll/Toleranz
                </th>
                <th scope="col" className="th">
                  Bemerkung
                </th>
              </tr>
            </thead>
            <tbody>
              {zeilen.map((z) => (
                <WertTabellenZeile
                  key={z.def.key}
                  z={z}
                  formId={f}
                  bearbeitbar={bearbeitbar}
                  toleranzEur={toleranzEur}
                  eingabe={eingaben[z.def.key] ?? ''}
                  bemerkung={bemerkungen[z.def.key] ?? ''}
                  erklaert={erklaert[z.def.key] ?? false}
                  setzeEingabe={(wert) => setEingaben((x) => ({ ...x, [z.def.key]: wert }))}
                  setzeBemerkung={(wert) => setBemerkungen((x) => ({ ...x, [z.def.key]: wert }))}
                  setzeErklaert={(wert) => setErklaert((x) => ({ ...x, [z.def.key]: wert }))}
                />
              ))}
            </tbody>
          </table>
        </div>
      </section>
    ) : null;

  const optionen = [
    { wert: 'OHNE_BEFUND', text: 'ohne Befund' },
    { wert: 'MIT_BEFUND', text: 'mit Befund' },
  ] as const;
  const ergebnisKarte = (
    <section className="card" aria-labelledby="df-ergebnis">
      <div className="card-header">
        <h3 id="df-ergebnis" className="text-sm font-semibold text-primary">
          Ergebnis
        </h3>
        <span className="text-xs text-muted">
          {bearbeitbar ? 'Vorschlag für die Gegenzeichnung' : 'Angabe der durchführenden Person'}
        </span>
      </div>
      <div className="px-6 py-4">
        <fieldset>
          <legend className="sr-only">Ergebnis der Durchführung</legend>
          <div className="flex flex-col gap-1.5">
            {optionen.map((o) => (
              <label key={o.wert} className="inline-flex items-center gap-2">
                <input
                  type="radio"
                  name="ergebnis"
                  value={o.wert}
                  form={f}
                  checked={wahl === o.wert}
                  disabled={!bearbeitbar}
                  title={titel}
                  onChange={() => setWahl(o.wert)}
                />
                <span
                  className={`text-sm${!bearbeitbar && wahl !== o.wert ? ' text-muted' : ' text-primary'}`}
                >
                  {o.text}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {bearbeitbar ? (
          <div className="mt-3">
            <label htmlFor="df-ergebnis-kommentar" className="sr-only">
              Kommentar zum Ergebnis
            </label>
            <textarea
              {...TCMS_TEXT_ISOLIERT}
              id="df-ergebnis-kommentar"
              className="input"
              rows={3}
              name="ergebnisKommentar"
              form={f}
              defaultValue={ergebnisKommentar ?? ''}
              placeholder="Beschreibung des Befunds bzw. Bemerkung zum Ergebnis …"
              maxLength={4000}
              aria-describedby="df-ergebnis-hinweis"
            />
            <p id="df-ergebnis-hinweis" className="hint">
              Bei „mit Befund“ Pflicht (mindestens {minBefund} Zeichen); die Feststellung wird bei
              der Gegenzeichnung erfasst.
            </p>
          </div>
        ) : ergebnisKommentar ? (
          <p className="text-sm text-secondary mt-2 whitespace-pre-wrap" {...TCMS_TEXT_ISOLIERT}>
            {ergebnisKommentar}
          </p>
        ) : null}
        {ergebnisZusatz}
      </div>
    </section>
  );

  return (
    <>
      {schrittKarte}
      {toleranzKarten}
      {werteKarte}
      {nachweise}
      {ergebnisKarte}
    </>
  );
}
