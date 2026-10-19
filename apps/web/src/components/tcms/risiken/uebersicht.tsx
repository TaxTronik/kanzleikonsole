// =============================================================================
// Inhalt des Risikoinventars (TCMS Stufe 3): Liste mit Freigabe-Auswahl oder
// Heatmap, Leerzustand bei Filtern ohne Treffer, Umschalter der Ansicht.
// Reine Anzeige der Antwort von `GET …/risiken`.
// =============================================================================

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Search } from 'lucide-react';
import type { KontextAntwort, RisikenListe, RisikoEintrag } from '@taxtronik/tcms-contract';
import { KLASSE_LABEL, KLASSEN } from '@taxtronik/tcms-domain';
import type { TcmsNamen } from '@/server/tcms/namen';
import { KlasseBadge } from '../badges';
import type { TcmsAktion } from '../bereich-b/ergebnis';
import { RisikoHeatmap } from '../heatmap';
import { TcmsLeer } from '../leer';
import { FreigabeAuswahl } from './freigabe-auswahl';
import { RisikoTabelle } from './inventar';

/** Umschalter Liste/Heatmap als Links (Zustand in der URL). */
export function AnsichtUmschalter<A extends string>({
  aktiv,
  optionen,
  href,
}: {
  aktiv: A;
  optionen: ReadonlyArray<readonly [A, string]>;
  href: (ansicht: A) => string;
}) {
  return (
    <nav aria-label="Ansicht" className="toggle-group">
      {optionen.map(([wert, label]) => (
        <Link
          key={wert}
          href={href(wert)}
          aria-current={aktiv === wert ? 'page' : undefined}
          className={`px-3 py-1.5 text-xs ${aktiv === wert ? 'bg-surface-raised font-semibold text-primary' : 'text-secondary'}`}
          scroll={false}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}

export function RisikenHeatmapKarte({
  liste,
  gefiltert,
  pfad,
  stand,
}: {
  liste: RisikenListe;
  gefiltert: readonly RisikoEintrag[];
  pfad: string;
  stand: string | null;
}) {
  return (
    <>
      <div className="card-header flex-wrap gap-2">
        <span className="text-sm font-semibold text-primary">
          Risiken – Bruttobewertung (S × W)
        </span>
        <span className="flex flex-wrap gap-2">
          {[...KLASSEN].reverse().map((k) => (
            <span key={k} className="inline-flex items-center gap-1 text-xs">
              <KlasseBadge klasse={k} />{' '}
              {gefiltert.filter((r) => r.bewertung.brutto.klasse === k).length}
            </span>
          ))}
        </span>
      </div>
      <div className="p-4">
        <RisikoHeatmap
          ziel={pfad}
          stand={stand}
          risiken={gefiltert.map((r) => ({
            code: r.code,
            s: r.s,
            w: r.w,
            brutto: r.bewertung.brutto.klasse,
            design: r.bewertung.wirksamDesign,
            betrieb: r.bewertung.wirksamBetrieb,
          }))}
        />
      </div>
      <div className="card-footer">
        <span>
          {gefiltert.length} von {liste.risiken.length} Risiken · Der Governance-Typ steuert die
          Kontrollhäufigkeit, nicht die Klasse.
        </span>
      </div>
    </>
  );
}

export function RisikenListenKarte({
  liste,
  gefiltert,
  kontrollen,
  namen,
  auswahl,
  detailHref,
  ausgewaehlt,
  freigabeSchritt,
  zuruecksetzenHref,
}: {
  liste: RisikenListe;
  gefiltert: readonly RisikoEintrag[];
  kontrollen: KontextAntwort['kontrollen'];
  namen: TcmsNamen;
  /** Auswählbar für den Freigabeschritt (true) oder Grund. */
  auswahl: (r: RisikoEintrag) => true | string;
  detailHref: (risikoId: string) => string;
  ausgewaehlt: string | null;
  freigabeSchritt: TcmsAktion;
  zuruecksetzenHref: string;
}) {
  if (gefiltert.length === 0) {
    return (
      <TcmsLeer icon={Search} text="Keine Risiken für diese Filter.">
        <Link href={zuruecksetzenHref} className="btn-secondary">
          Filter zurücksetzen
        </Link>
      </TcmsLeer>
    );
  }
  const mitAuswahl = gefiltert.some((r) => auswahl(r) === true);
  const ueberAppetit = liste.risiken.filter((r) => r.ueberAppetit).length;
  const fuss: ReactNode = (
    <>
      {liste.risiken.length} aktive Risiken · {ueberAppetit} über Appetit (Netto{' '}
      {liste.betriebAktiv ? 'Betrieb' : 'Design'})
      {gefiltert.length !== liste.risiken.length ? ` · ${gefiltert.length} angezeigt` : ''} ·
      Risikoappetit {KLASSE_LABEL[liste.appetit]}
    </>
  );
  const tabelle = (
    <RisikoTabelle
      risiken={gefiltert}
      kontrollen={kontrollen}
      appetit={liste.appetit}
      betriebAktiv={liste.betriebAktiv}
      namen={namen}
      optionen={{
        mitAuswahl,
        auswahl,
        detailHref: (r) => detailHref(r.id),
        ausgewaehlt,
      }}
    />
  );
  if (mitAuswahl) {
    return (
      <FreigabeAuswahl aktion={freigabeSchritt} fuss={fuss}>
        {tabelle}
      </FreigabeAuswahl>
    );
  }
  return (
    <>
      {tabelle}
      <div className="card-footer">
        <span>{fuss}</span>
      </div>
    </>
  );
}
