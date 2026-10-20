// =============================================================================
// Kleine Visualisierungen der Tax-CMS-Oberflächen (TCMS Stufe 3, aus der Demo
// components/ui/visual.tsx). Reines Markup ohne Client-Logik, nur mit
// Klassen der kanzleikonsole (stepper/step, dot-*, Token-Utilities): hell,
// dunkel und im barrierearmen Anzeigemodus lesbar. Jede Grafik hat eine
// Textalternative (aria-label, role="img"/"meter") und zeigt ihre Zahlen
// zusätzlich als Text; Farbe trägt nie allein die Bedeutung.
// =============================================================================

import { Check } from 'lucide-react';
import { PHASEN } from '@taxtronik/tcms-domain';
import { TCMS_TEXT_ISOLIERT } from './text';

/** Kurzbezeichnungen der sieben Phasen für enge Darstellungen. */
export const PHASEN_KURZ = [
  'Aufbau',
  'Risikoanalyse',
  'Kontrollplanung',
  'Beschreibung',
  'Angemessenheit dok.',
  'Wirksamkeitszeitraum',
  'Prüfung & Regelbetrieb',
] as const;

/** Phasen-Stepper (Klassen .stepper/.step der kanzleikonsole); scrollt auf schmalen Bildschirmen. */
export function PhasenStepper({
  phasen,
  aktiv,
  unterzeilen,
}: {
  phasen: ReadonlyArray<{ nr: number; name: string }>;
  aktiv: number;
  unterzeilen?: Readonly<Record<number, string>>;
}) {
  return (
    <div className="overflow-x-auto">
      <ol className="stepper min-w-[56rem]" aria-label={`Phase ${aktiv} von ${phasen.length}`}>
        {phasen.map((p, i) => {
          const zustand = p.nr < aktiv ? 'done' : p.nr === aktiv ? 'active' : '';
          return (
            <li
              key={p.nr}
              className={`step ${zustand}`}
              aria-current={p.nr === aktiv ? 'step' : undefined}
            >
              <span className="step-dot">
                {zustand === 'done' ? <Check className="h-4 w-4" aria-hidden="true" /> : p.nr}
              </span>
              <span className="step-txt">
                <span className="step-title" title={p.name}>
                  {PHASEN_KURZ[p.nr - 1] ?? p.name}
                </span>
                <span className="step-sub">
                  {unterzeilen?.[p.nr] ??
                    (p.nr < aktiv ? 'Gate erfüllt' : p.nr === aktiv ? 'aktiv' : '')}
                </span>
              </span>
              {i < phasen.length - 1 ? <span className="step-line" aria-hidden="true" /> : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Kompakte Phasenanzeige (Portfolio, Portal) mit Phasennamen als Tooltip. */
export function MiniSteps({ aktiv, gesamt = PHASEN.length }: { aktiv: number; gesamt?: number }) {
  return (
    <span
      className="inline-flex items-center gap-0.5"
      role="img"
      aria-label={`Phase ${aktiv} von ${gesamt}: ${PHASEN[aktiv - 1] ?? ''}`}
    >
      {Array.from({ length: gesamt }, (_, i) => (
        <span
          key={i}
          title={PHASEN[i]}
          className={`h-1.5 w-3 rounded-full ${
            i + 1 < aktiv ? 'bg-brand-600' : i + 1 === aktiv ? 'bg-brand-300' : 'bg-surface-sunken'
          }`}
        />
      ))}
    </span>
  );
}

const FUELLUNG = {
  brand: 'bg-brand-600',
  gruen: 'dot-green',
  gelb: 'dot-amber',
  rot: 'dot-red',
  grau: 'dot-gray',
} as const;
export type Fuellung = keyof typeof FUELLUNG;

/** Horizontale Balken mit Beschriftung und Wert (z. B. Prüflast je Governance-Typ). */
export function BalkenZeilen({
  zeilen,
  label,
}: {
  zeilen: ReadonlyArray<{ label: string; wert: number; text?: string; fuellung?: Fuellung }>;
  label: string;
}) {
  const max = Math.max(1, ...zeilen.map((z) => z.wert));
  return (
    <dl className="space-y-1.5" aria-label={label}>
      {zeilen.map((z) => (
        <div key={z.label} className="grid grid-cols-[9rem_1fr_3rem] items-center gap-2 text-xs">
          <dt className="text-secondary truncate">{z.label}</dt>
          <dd className="h-2 rounded-full bg-surface-sunken overflow-hidden" aria-hidden="true">
            <span
              className={`block h-full rounded-full ${FUELLUNG[z.fuellung ?? 'brand']}`}
              style={{ width: `${(Math.max(0, z.wert) / max) * 100}%` }}
            />
          </dd>
          <dd className="text-right font-mono tabular-nums text-primary">{z.text ?? z.wert}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Fortschrittsbalken mit Textalternative (z. B. Monat 4 von 12). */
export function Fortschritt({ anteil, label }: { anteil: number; label: string }) {
  const prozent = Math.round(Math.min(1, Math.max(0, anteil)) * 100);
  return (
    <div
      className="h-2 rounded-full bg-surface-sunken overflow-hidden"
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={prozent}
      aria-label={label}
    >
      <span className="block h-full rounded-full bg-brand-600" style={{ width: `${prozent}%` }} />
    </div>
  );
}

/**
 * Gestapelter Balken mit Legende (ersetzt den Donut der Demo, der eigene
 * Farben brauchte). Die Legende nennt jede Zahl als Text.
 */
export function SegmentBalken({
  teile,
  label,
}: {
  teile: ReadonlyArray<{ label: string; wert: number; fuellung: Fuellung }>;
  label: string;
}) {
  const summe = teile.reduce((s, t) => s + Math.max(0, t.wert), 0);
  return (
    <div>
      <div
        className="flex h-2.5 rounded-full bg-surface-sunken overflow-hidden"
        role="img"
        aria-label={`${label}: ${teile.map((t) => `${t.wert} ${t.label}`).join(', ')}`}
      >
        {summe > 0
          ? teile.map((t) =>
              t.wert > 0 ? (
                <span
                  key={t.label}
                  className={`block h-full ${FUELLUNG[t.fuellung]}`}
                  style={{ width: `${(t.wert / summe) * 100}%` }}
                />
              ) : null,
            )
          : null}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-secondary">
        {teile.map((t) => (
          <li key={t.label} className="inline-flex items-center gap-1.5">
            <span className={`status-dot ${FUELLUNG[t.fuellung]}`} aria-hidden="true" />
            {t.wert} {t.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Anteil an einer Schwelle (EU-Lieferschwelle): Warnung ab 80 %, über 100 % rot. */
export function SchwellenAnzeige({ anteil, label }: { anteil: number; label: string }) {
  const prozent = Math.round(Math.max(0, anteil) * 100);
  const fuellung: Fuellung = anteil > 1 ? 'rot' : anteil >= 0.8 ? 'gelb' : 'gruen';
  return (
    <div
      className="relative h-2 rounded-full bg-surface-sunken overflow-hidden"
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.min(100, prozent)}
      aria-valuetext={`${prozent} %`}
      aria-label={label}
    >
      <span
        className={`block h-full rounded-full ${FUELLUNG[fuellung]}`}
        style={{ width: `${Math.min(100, prozent)}%` }}
      />
    </div>
  );
}

/** Monatssegmente eines Zeitraums (Portal): erledigt, laufend, offen, nicht begonnen. */
export function ZeitraumLeiste({
  monate,
}: {
  monate: ReadonlyArray<{ label: string; zustand: 'done' | 'now' | 'offen' | ''; offen: number }>;
}) {
  const TEXT = {
    done: 'ohne offene Aufgaben',
    now: 'laufend',
    offen: 'Aufgabe offen',
    '': 'noch nicht begonnen',
  };
  return (
    <ol
      className="grid gap-1"
      style={{ gridTemplateColumns: `repeat(${Math.max(1, monate.length)}, minmax(0, 1fr))` }}
      aria-label="Monate des Zeitraums"
    >
      {monate.map((m, i) => (
        <li
          key={`${m.label}-${i}`}
          className={`rounded-md border px-2 py-1.5 text-xs text-center ${
            m.zustand === 'now'
              ? 'border-brand-600 bg-brand-50 text-brand-700 font-semibold'
              : m.zustand === 'offen'
                ? 'chip-red'
                : m.zustand === 'done'
                  ? 'chip-green'
                  : 'border-default text-muted'
          }`}
        >
          <span {...TCMS_TEXT_ISOLIERT}>{m.label}</span>
          <span className="sr-only">
            {' '}
            – {TEXT[m.zustand]}
            {m.offen > 0 ? `, ${m.offen} offen` : ''}
          </span>
        </li>
      ))}
    </ol>
  );
}
