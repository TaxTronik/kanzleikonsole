// =============================================================================
// Kopfzeile einer Tax-CMS-Seite des Mandanten (TCMS Stufe 3, aus der Demo
// components/tcms/kopf.tsx): Teilbereich, Phase und Stichtag; bei einem
// historischen Stand ein Hinweis „nur Lesen“. Der Stichtag wird per GET
// gewählt (ohne Client-Logik); ob ein Stand historisch ist, sagt der Dienst.
// =============================================================================

import Link from 'next/link';
import type { ReactNode } from 'react';
import { History } from 'lucide-react';
import { PHASEN } from '@taxtronik/tcms-domain';
import { isoDatumText } from './format';
import { TCMS_TEXT_ISOLIERT } from './text';

export interface TcmsKopfDaten {
  teilbereich: { name: string } | null;
  /** Phase nur, wenn ein Programm besteht. */
  aktivePhase: number | null;
  historisch: boolean;
  /** Stand und heute als `YYYY-MM-DD` aus der Antwort des Dienstes. */
  stand: string;
  heute: string;
  ausgeblendet: number;
}

export function TcmsKopf({
  daten,
  titel,
  rechts,
}: {
  daten: TcmsKopfDaten;
  titel?: ReactNode;
  rechts?: ReactNode;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div className="flex flex-wrap items-center gap-2">
          {titel}
          {daten.teilbereich ? (
            <span className="badge-brand" {...TCMS_TEXT_ISOLIERT}>
              {daten.teilbereich.name}
            </span>
          ) : null}
          {daten.aktivePhase ? (
            <span className="badge-purple" title={PHASEN[daten.aktivePhase - 1]}>
              Phase {daten.aktivePhase} von {PHASEN.length} · {PHASEN[daten.aktivePhase - 1]}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <form method="get" className="flex items-center gap-2">
            <label htmlFor="tcms-stand" className="text-xs text-secondary">
              Stichtag
            </label>
            <input
              id="tcms-stand"
              name="stand"
              type="date"
              className="input py-1 text-xs w-auto"
              defaultValue={daten.stand}
              max={daten.heute}
            />
            <button type="submit" className="btn-secondary text-xs py-1">
              Anzeigen
            </button>
          </form>
          {rechts}
        </div>
      </div>
      {daten.historisch ? (
        <div
          className="alert-warning mb-3 flex flex-wrap items-center justify-between gap-2"
          role="status"
        >
          <span className="inline-flex items-center gap-2">
            <History className="h-4 w-4" aria-hidden="true" />
            <span>
              <strong>Stand zum {isoDatumText(daten.stand)} – nur Lesen.</strong> Änderungen wirken
              auf den aktuellen Stand.
              {daten.ausgeblendet > 0
                ? ` ${daten.ausgeblendet} Einträge sind wegen des Stichtags ausgeblendet.`
                : ''}
            </span>
          </span>
          <Link href="?" className="btn-secondary text-xs py-1">
            Zum aktuellen Stand
          </Link>
        </div>
      ) : null}
    </>
  );
}
