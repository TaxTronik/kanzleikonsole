// Filterzeile des Risikoinventars als GET-Formular (TCMS Stufe 3; die Demo
// filtert per Client-Router). Stichtag und Ansicht bleiben als verborgene
// Felder erhalten, ebenso ein Filter aus der Heatmap, der sich per Link
// entfernen lässt.
import Link from 'next/link';
import { RotateCcw, Search, X } from 'lucide-react';
import {
  GOVERNANCE_TYPEN,
  GRUPPE_LABEL,
  KLASSE_LABEL,
  KLASSEN,
  SCHADEN_LABEL,
  WAHRSCHEINLICHKEIT_LABEL,
} from '@taxtronik/tcms-domain';
import { RISIKO_GRUPPEN, risikoFilterAktiv, type RisikoFilter } from './filter';

export function RisikoFilterFormular({
  pfad,
  filter,
  stand,
  ansicht,
  anzahlNeu,
  ohneHeatmapHref,
  zuruecksetzenHref,
}: {
  pfad: string;
  filter: RisikoFilter;
  stand: string | null;
  ansicht: 'liste' | 'heatmap';
  anzahlNeu: number;
  ohneHeatmapHref: string;
  zuruecksetzenHref: string;
}) {
  return (
    <form
      method="get"
      action={pfad}
      className="card p-4 mb-4 flex flex-wrap items-end gap-4"
      aria-label="Risiken filtern"
    >
      {stand ? <input type="hidden" name="stand" value={stand} /> : null}
      {ansicht === 'heatmap' ? <input type="hidden" name="ansicht" value="heatmap" /> : null}
      {filter.s && filter.w ? (
        <>
          <input type="hidden" name="s" value={filter.s} />
          <input type="hidden" name="w" value={filter.w} />
        </>
      ) : null}
      <div>
        <label className="label-sm" htmlFor="tcms-r-gruppe">
          Gruppe
        </label>
        <select
          id="tcms-r-gruppe"
          name="gruppe"
          className="input w-auto"
          defaultValue={filter.gruppe}
        >
          <option value="">Alle</option>
          {RISIKO_GRUPPEN.map((g) => (
            <option key={g} value={g}>
              {g} · {GRUPPE_LABEL[g]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label-sm" htmlFor="tcms-r-gt">
          Governance-Typ
        </label>
        <select id="tcms-r-gt" name="gt" className="input w-auto" defaultValue={filter.gt}>
          <option value="">Alle</option>
          {GOVERNANCE_TYPEN.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label-sm" htmlFor="tcms-r-klasse">
          Klasse (brutto)
        </label>
        <select
          id="tcms-r-klasse"
          name="klasse"
          className="input w-auto"
          defaultValue={filter.klasse}
        >
          <option value="">Alle</option>
          {[...KLASSEN].reverse().map((k) => (
            <option key={k} value={k}>
              {KLASSE_LABEL[k]}
            </option>
          ))}
        </select>
      </div>
      <fieldset className="flex flex-wrap gap-4 pb-2">
        <legend className="sr-only">Weitere Filter</legend>
        <label className="inline-flex items-center gap-1.5 text-sm">
          <input type="checkbox" name="appetit" value="1" defaultChecked={filter.appetit} /> nur
          über Appetit
        </label>
        <label className="inline-flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            name="uebersteuert"
            value="1"
            defaultChecked={filter.uebersteuert}
          />{' '}
          nur übersteuert
        </label>
        <label className="inline-flex items-center gap-1.5 text-sm">
          <input type="checkbox" name="kern" value="1" defaultChecked={filter.kern} /> nur
          Kernrisiken
        </label>
        <label
          className="inline-flex items-center gap-1.5 text-sm"
          title="Ereignis oder Profiländerung nach der letzten Bewertung"
        >
          <input type="checkbox" name="neu" value="1" defaultChecked={filter.neu} /> nur „neu
          bewerten“
          {anzahlNeu > 0 ? <span className="badge-yellow">{anzahlNeu}</span> : null}
        </label>
      </fieldset>
      <div className="flex flex-wrap items-center gap-2 ml-auto">
        {filter.s && filter.w ? (
          <span className="badge-brand gap-1">
            Heatmap: Schaden {SCHADEN_LABEL[filter.s]} · {WAHRSCHEINLICHKEIT_LABEL[filter.w]}
            <Link href={ohneHeatmapHref} aria-label="Heatmap-Filter entfernen" scroll={false}>
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </span>
        ) : null}
        {risikoFilterAktiv(filter) ? (
          <Link href={zuruecksetzenHref} className="btn-secondary" scroll={false}>
            <RotateCcw className="h-4 w-4" aria-hidden="true" /> Filter zurücksetzen
          </Link>
        ) : null}
        <button type="submit" className="btn-secondary">
          <Search className="h-4 w-4" aria-hidden="true" /> Anwenden
        </button>
      </div>
    </form>
  );
}
