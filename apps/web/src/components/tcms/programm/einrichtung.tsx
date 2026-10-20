// =============================================================================
// Einrichtungsassistent des Tax-CMS: Schrittleiste, Stufenkarten und
// Zusammenfassung (TCMS Stufe 3, Bereich A; aus der Demo
// components/setup/schrittleiste.tsx und anzeige.ts). Reine Anzeige ohne
// Client-Logik: Plan, Prüflast und Zeiträume kommen aus `einrichtungLesen`,
// hier wird nichts berechnet.
// =============================================================================

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Check, Pencil } from 'lucide-react';
import type { PlanView } from '@taxtronik/tcms-contract';
import { addTage, KLASSE_LABEL, MONATE, TURNUS_LABEL, type Klasse } from '@taxtronik/tcms-domain';
import { alsDatum, isoDatumText } from '../format';
import { TCMS_TEXT_ISOLIERT, TcmsText } from '@/components/tcms/text';

export const SCHRITTE = [
  { nr: 1, titel: 'Teilbereich', sub: 'Paketvorlage, Abgrenzung und Zeiträume' },
  { nr: 2, titel: 'Geschäftsprofil', sub: 'P1–P12' },
  { nr: 3, titel: 'Compliance-Ziele', sub: 'Wesentlichkeit und Risikoappetit' },
  { nr: 4, titel: 'Risikovorschlag', sub: 'übernehmen oder begründet ablehnen' },
  { nr: 5, titel: 'Kontrollvorschlag', sub: 'Zuständigkeiten und Frequenzen' },
] as const;

export type SchrittNr = (typeof SCHRITTE)[number]['nr'];

export const STUFEN_UNTERTITEL: Readonly<Record<number, string>> = {
  1: 'Festlegen, welcher Teilbereich mit welcher Paketvorlage eingerichtet wird; dazu Angemessenheits-Stichtag und Wirksamkeitszeitraum.',
  2: 'Die Antworten steuern Risikovorschlag (Schritt 4) und Kontrollvorschlag (Schritt 5).',
  3: 'Vorlagen aus dem Paket; Wesentlichkeitsgrenze und Risikoappetit je Ziel festlegen.',
  4: 'Vorschlag aus dem Paket auf Basis des Geschäftsprofils; Brutto-Startwerte aus dem Bewertungsmodell.',
  5: 'Vorlagen je übernommenem Risiko; Partei und Personen zuweisen, Frequenz aus der Häufigkeitsmatrix. Gegenzeichnung ist bei Schlüsselkontrollen Pflicht.',
};

/** Dauer eines Zeitraums als Text, z. B. „6 Monate“ oder „rund 5,5 Monate“ (nur Anzeige). */
export function dauerText(abIso: string, bisIso: string): string | null {
  const ab = /^\d{4}-\d{2}-\d{2}$/.test(abIso) ? alsDatum(abIso) : null;
  const bis = /^\d{4}-\d{2}-\d{2}$/.test(bisIso) ? alsDatum(bisIso) : null;
  if (!ab || !bis || bis.getTime() < ab.getTime()) return null;
  const nach = addTage(bis, 1);
  const volle =
    (nach.getUTCFullYear() - ab.getUTCFullYear()) * 12 + nach.getUTCMonth() - ab.getUTCMonth();
  if (nach.getUTCDate() === ab.getUTCDate()) return `${volle} ${volle === 1 ? 'Monat' : 'Monate'}`;
  const tage = Math.round((nach.getTime() - ab.getTime()) / 86_400_000);
  return `rund ${(tage / 30.44).toLocaleString('de-DE', { maximumFractionDigits: 1 })} Monate`;
}

/** Schrittleiste mit Links auf erreichbare Schritte (`aria-current="step"` am aktiven). */
export function Schrittleiste({
  aktiv,
  abgeschlossen,
  href,
  unterzeilen,
}: {
  aktiv: number;
  abgeschlossen: number;
  href: (n: number) => string;
  unterzeilen: Readonly<Record<number, string>>;
}) {
  return (
    <nav aria-label="Schritte des Einrichtungsassistenten" className="overflow-x-auto">
      <ol className="stepper min-w-[48rem]">
        {SCHRITTE.map((s, i) => {
          const zustand = s.nr === aktiv ? 'active' : s.nr <= abgeschlossen ? 'done' : '';
          const erreichbar = s.nr <= abgeschlossen + 1;
          const inhalt = (
            <>
              <span className="step-dot">
                {zustand === 'done' ? <Check className="h-4 w-4" aria-hidden="true" /> : s.nr}
              </span>
              <span className="step-txt">
                <span className="step-title">
                  {s.nr} <TcmsText>{s.titel}</TcmsText>
                  {zustand === 'done' ? <span className="sr-only"> (erledigt)</span> : null}
                </span>
                <span className="step-sub">
                  {unterzeilen[s.nr] ??
                    (zustand === 'done' ? 'erledigt' : zustand === 'active' ? 'aktuell' : 'offen')}
                </span>
              </span>
            </>
          );
          return (
            <li key={s.nr} className={`step ${zustand}`}>
              {erreichbar && s.nr !== aktiv ? (
                <Link href={href(s.nr)} className="flex min-w-0 items-center gap-2">
                  {inhalt}
                </Link>
              ) : (
                <span
                  className="flex min-w-0 items-center gap-2"
                  aria-current={s.nr === aktiv ? 'step' : undefined}
                >
                  {inhalt}
                </span>
              )}
              {i < SCHRITTE.length - 1 ? <span className="step-line" aria-hidden="true" /> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Eingeklappte Stufe (erledigt oder offen) mit Kurzfassung. */
export function StufeZu({
  nr,
  titel,
  text,
  erledigt,
  href,
}: {
  nr: number;
  titel: string;
  text: ReactNode;
  erledigt: boolean;
  href: string | null;
}) {
  const id = `einrichtung-stufe-${nr}`;
  return (
    <section className="card mb-4" aria-labelledby={id}>
      <div className="flex items-center gap-3 px-6 py-3">
        <span
          className={`kpi-chip ${erledigt ? 'chip-green' : 'chip-gray'} shrink-0`}
          aria-hidden="true"
        >
          {erledigt ? <Check className="h-4 w-4" /> : nr}
        </span>
        <div className="min-w-0 grow">
          <h3
            id={id}
            className={`text-sm font-semibold ${erledigt ? 'text-primary' : 'text-muted'}`}
          >
            {nr} · {titel}
            {erledigt ? <span className="sr-only"> (erledigt)</span> : null}
          </h3>
          <p className="text-xs text-muted">{text}</p>
        </div>
        {href ? (
          <Link href={href} className="btn-secondary text-xs py-1 shrink-0">
            {erledigt ? (
              <>
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" /> Bearbeiten
              </>
            ) : (
              'Öffnen'
            )}
            <span className="sr-only"> – Schritt {nr}</span>
          </Link>
        ) : null}
      </div>
    </section>
  );
}

/** Geöffnete Stufe mit dem Formular des Schritts. */
export function StufeOffen({
  nr,
  titel,
  children,
}: {
  nr: number;
  titel: string;
  children: ReactNode;
}) {
  const id = `einrichtung-stufe-${nr}`;
  return (
    <section className="card mb-4 border-brand-300" aria-labelledby={id} id={`schritt-${nr}`}>
      <div className="flex flex-wrap items-start gap-3 px-6 py-4 border-b border-default">
        <span className="kpi-chip chip-brand shrink-0" aria-hidden="true">
          {nr}
        </span>
        <div className="min-w-0 grow">
          <h3 id={id} className="text-base font-semibold text-primary">
            {titel}
          </h3>
          <p className="text-xs text-muted mt-0.5">{STUFEN_UNTERTITEL[nr]}</p>
        </div>
        <span className="badge-gray shrink-0">Schritt {nr} von 5</span>
      </div>
      {children}
    </section>
  );
}

export interface ZusammenfassungDaten {
  teilbereich: string;
  zeitraum: PlanView['zeitraum'];
  turnus: 'MONATLICH' | 'QUARTALSWEISE' | 'JAEHRLICH';
  ziele: number;
  appetit: Klasse;
  /** Name der gesetzlichen Vertretung aus der kanzleikonsole oder null (keine Anforderung). */
  freigabeAn: string | null;
  risiken: number;
  kern: number;
  abgelehnt: number;
  kontrollen: number;
  schluessel: number;
  durchfuehrungen: number;
  prueflast: PlanView['prueflast'];
}

function monatKurz(m: string): string {
  return `${MONATE[Number(m.slice(5, 7)) - 1]?.slice(0, 3) ?? m} ${m.slice(2, 4)}`;
}

/** Zusammenfassung vor „Version 1 anlegen“ (alle Zahlen aus dem Plan des Dienstes). */
export function Zusammenfassung({ d }: { d: ZusammenfassungDaten }) {
  const zeilen: Array<[string, string]> = [
    ['Teilbereich', d.teilbereich],
    ['Angemessenheit zum Stichtag', isoDatumText(d.zeitraum?.stichtag)],
    [
      'Wirksamkeitszeitraum',
      d.zeitraum ? `${isoDatumText(d.zeitraum.ab)} – ${isoDatumText(d.zeitraum.bis)}` : '—',
    ],
    ['Erklärungsturnus', TURNUS_LABEL[d.turnus]],
    ['Compliance-Ziele', `${d.ziele} · höchster Risikoappetit ${KLASSE_LABEL[d.appetit]}`],
    [
      'Freigabe der Ziele',
      d.freigabeAn ? `wird bei ${d.freigabeAn} angefordert` : 'keine Anforderung',
    ],
  ];
  return (
    <section className="card mt-4" aria-labelledby="einrichtung-zusammenfassung">
      <div className="card-header">
        <h4 id="einrichtung-zusammenfassung" className="text-sm font-semibold text-primary">
          Zusammenfassung Version 1
        </h4>
        <span className="badge-gray">Entwurf</span>
      </div>
      <div className="p-4">
        <ul className="mini-kpis">
          <li className="mini-kpi">
            <div className="v">{d.risiken}</div>
            <div className="l">Risiken übernommen, davon {d.kern} Kernrisiken</div>
          </li>
          <li className="mini-kpi">
            <div className="v">{d.abgelehnt}</div>
            <div className="l">Vorschläge begründet abgelehnt</div>
          </li>
          <li className="mini-kpi">
            <div className="v">{d.kontrollen}</div>
            <div className="l">Kontrollen, davon {d.schluessel} Schlüsselkontrollen</div>
          </li>
          <li className="mini-kpi">
            <div className="v">{d.durchfuehrungen}</div>
            <div className="l">Durchführungen im Wirksamkeitszeitraum geplant</div>
          </li>
        </ul>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-4">
          <dl className="space-y-1">
            {zeilen.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3">
                <dt className="text-sm text-secondary">{k}</dt>
                <dd className="text-sm text-right" {...TCMS_TEXT_ISOLIERT}>
                  {v}
                </dd>
              </div>
            ))}
          </dl>
          <div>
            <p className="text-xs font-semibold text-secondary mb-2" id="einrichtung-prueflast">
              Manuelle Prüflast je Monat (Prognose aus den geplanten Durchführungen)
            </p>
            {d.prueflast.length === 0 ? (
              <p className="text-sm text-muted">Noch kein Wirksamkeitszeitraum geplant.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs" aria-labelledby="einrichtung-prueflast">
                  <thead>
                    <tr>
                      <th scope="col" className="th">
                        <span className="sr-only">Governance-Typ</span>
                      </th>
                      {d.prueflast.map((p) => (
                        <th key={p.monat} scope="col" className="th td-num">
                          {monatKurz(p.monat)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(['FP', 'FF', 'IN'] as const).map((gt) => (
                      <tr key={gt} className="border-t border-default">
                        <th scope="row" className="px-2 py-1 text-left font-normal">
                          {gt}
                        </th>
                        {d.prueflast.map((p) => (
                          <td key={p.monat} className="td-num px-2 py-1">
                            {p[gt]}
                          </td>
                        ))}
                      </tr>
                    ))}
                    <tr className="border-t border-default font-semibold">
                      <th scope="row" className="px-2 py-1 text-left">
                        gesamt
                      </th>
                      {d.prueflast.map((p) => (
                        <td key={p.monat} className="td-num px-2 py-1">
                          {p.gesamt}
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
            <p className="hint">Zuzüglich anlassbezogener Prüfungen bei jeder Auslösung (FF/IN).</p>
          </div>
        </div>
        <p className="hint mt-3">
          Nach dem Anlegen steht das Tax-CMS in Phase 1 „Aufbau“, bis die gesetzlichen Vertreter die
          Ziele freigeben. Inventarfreigabe im Vier-Augen-Prinzip und Designbeurteilung der
          Kontrollen folgen in Phase 2 und 3.
        </p>
      </div>
    </section>
  );
}
