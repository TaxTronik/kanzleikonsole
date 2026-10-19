'use client';

// =============================================================================
// Risiko-Heatmap 3 × 4 (TCMS Stufe 3, aus der Demo components/ui/heatmap.tsx):
// Zelle = Schaden × Wahrscheinlichkeit, Farbe = höchste Klasse der gewählten
// Sicht (Brutto, Netto Design, Netto Betrieb). Die Klassen berechnet der
// Dienst; die Heatmap zählt und sortiert nur für die Anzeige.
//
// Barrierearm: Tabelle mit Spalten-/Zeilenköpfen, jede Zelle ist ein Link
// mit vollständiger Beschreibung (Anzahl, höchste Klasse, Codes); die Sicht
// wählt eine Schaltflächengruppe mit aria-pressed. Farben nur über chip-*.
// =============================================================================

import Link from 'next/link';
import { useState } from 'react';
import {
  KLASSE_LABEL,
  KLASSE_RANG,
  SCHADEN_LABEL,
  WAHRSCHEINLICHKEIT_LABEL,
  WAHRSCHEINLICHKEITEN,
  type Klasse,
  type Schaden,
  type Wahrscheinlichkeit,
} from '@taxtronik/tcms-domain';
import { KLASSE_CHIP } from './ton';

export interface HeatRisiko {
  code: string;
  s: Schaden;
  w: Wahrscheinlichkeit;
  brutto: Klasse;
  design: Klasse;
  betrieb: Klasse;
}

type Sicht = 'brutto' | 'design' | 'betrieb';

const SICHTEN: ReadonlyArray<[Sicht, string]> = [
  ['brutto', 'Brutto'],
  ['design', 'Netto Design'],
  ['betrieb', 'Netto Betrieb'],
];

const NOTIZ: Readonly<Record<Sicht, string>> = {
  brutto: 'Bruttobewertung nach Schaden × Wahrscheinlichkeit.',
  design: 'Netto (Design): Bewertung des Dienstes nach angemessen beurteilten Kontrollen.',
  betrieb: 'Netto (Betrieb): Bewertung des Dienstes nach Durchführungen im Zeitraum.',
};

const SCHAEDEN_ABSTEIGEND: readonly Schaden[] = ['H', 'M', 'N'];

/** Link zur gefilterten Risikoliste, z. B. `<ziel>?s=H&w=SELTEN` (Stichtag bleibt erhalten). */
export function heatmapHref(
  ziel: string,
  s: Schaden,
  w: Wahrscheinlichkeit,
  stand?: string | null,
): string {
  const query = new URLSearchParams();
  if (stand) query.set('stand', stand);
  query.set('s', s);
  query.set('w', w);
  return `${ziel}?${query.toString()}`;
}

/**
 * `ziel`: Pfad der Risikoliste (`${basis}/risiken`); `stand`: historischer
 * Stichtag der Seite oder null. Props bleiben serialisierbar (Server → Client).
 */
export function RisikoHeatmap({
  risiken,
  ziel,
  stand = null,
}: {
  risiken: readonly HeatRisiko[];
  ziel: string;
  stand?: string | null;
}) {
  const [sicht, setSicht] = useState<Sicht>('brutto');
  const zaehler: Record<Klasse, number> = { KRITISCH: 0, HOCH: 0, MITTEL: 0, GERING: 0 };
  for (const r of risiken) zaehler[r[sicht]]++;
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="toggle-group" role="group" aria-label="Bewertungssicht">
          {SICHTEN.map(([k, label]) => (
            <button
              key={k}
              type="button"
              aria-pressed={sicht === k}
              className={`px-3 py-1.5 ${sicht === k ? 'bg-surface-raised font-semibold text-primary' : 'text-secondary'}`}
              onClick={() => setSicht(k)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted font-mono">
          {zaehler.KRITISCH} kritisch · {zaehler.HOCH} hoch · {zaehler.MITTEL} mittel ·{' '}
          {zaehler.GERING} gering
        </span>
      </div>
      <table className="w-full table-fixed border-separate border-spacing-1 text-xs">
        <caption className="sr-only">
          Risiko-Heatmap, Sicht {SICHTEN.find(([k]) => k === sicht)?.[1]}
        </caption>
        <thead>
          <tr>
            <th scope="col" className="w-28">
              <span className="sr-only">Schaden</span>
            </th>
            {WAHRSCHEINLICHKEITEN.map((w) => (
              <th key={w} scope="col" className="font-medium text-secondary">
                {WAHRSCHEINLICHKEIT_LABEL[w]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {SCHAEDEN_ABSTEIGEND.map((s) => (
            <tr key={s}>
              <th scope="row" className="text-left font-medium text-secondary">
                Schaden {SCHADEN_LABEL[s]}
              </th>
              {WAHRSCHEINLICHKEITEN.map((w) => {
                const drin = risiken.filter((r) => r.s === s && r.w === w);
                const max = drin.reduce<Klasse | null>(
                  (m, r) => (!m || KLASSE_RANG[r[sicht]] > KLASSE_RANG[m] ? r[sicht] : m),
                  null,
                );
                const beschreibung = drin.length
                  ? `${drin.length} Risiken, höchste Klasse ${KLASSE_LABEL[max!]}: ${drin.map((r) => r.code).join(', ')}`
                  : 'keine Risiken';
                return (
                  <td key={w}>
                    {drin.length ? (
                      <Link
                        href={heatmapHref(ziel, s, w, stand)}
                        className={`kpi-chip ${KLASSE_CHIP[max!]} w-full h-14 flex-col text-center no-underline`}
                        aria-label={`Schaden ${SCHADEN_LABEL[s]}, ${WAHRSCHEINLICHKEIT_LABEL[w]}: ${beschreibung}`}
                        title={beschreibung}
                      >
                        <span className="text-base font-bold leading-none">{drin.length}</span>
                        <span className="mt-1">{KLASSE_LABEL[max!]}</span>
                      </Link>
                    ) : (
                      <span
                        className="kpi-chip chip-gray w-full h-14 opacity-60"
                        aria-label={`Schaden ${SCHADEN_LABEL[s]}, ${WAHRSCHEINLICHKEIT_LABEL[w]}: keine Risiken`}
                        role="img"
                      />
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-muted mt-2">
        {NOTIZ[sicht]} Eine Zelle öffnet das gefilterte Inventar.
      </p>
    </div>
  );
}
