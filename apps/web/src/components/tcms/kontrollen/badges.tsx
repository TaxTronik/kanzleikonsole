// =============================================================================
// Plaketten der Kontrollmatrix (TCMS Stufe 3, portiert aus der Demo
// components/kontrollen/badges.tsx). UI-Sprache des TCMS: „Designbeurteilung:
// angemessen“ immer mit Person und Datum, nie als Systemaussage.
// =============================================================================

import { CircleDot, KeyRound } from 'lucide-react';
import type { KontrollDurchfuehrung, KontrolleEintrag } from '@taxtronik/tcms-contract';
import { ANZEIGE_BADGE, ANZEIGE_LABEL } from '@taxtronik/tcms-domain';
import { isoDatumKurzText, isoDatumText } from '../format';
import { badgeKlasse } from '../ton';

/** Designbeurteilung: „angemessen · Name · Datum“, „nicht beurteilt“ oder „Mangel · …“. */
export function DesignBadge({
  design,
  von,
  am,
  begruendung,
  kurz,
}: {
  design: KontrolleEintrag['design'];
  /** Name aus der kanzleikonsole (nie aus dem Dienst). */
  von: string;
  am: string | null;
  begruendung?: string | null;
  kurz?: boolean;
}) {
  if (design === 'NICHT_BEURTEILT') return <span className="badge-gray">nicht beurteilt</span>;
  const ergebnis = design === 'ANGEMESSEN' ? 'angemessen' : 'Mangel';
  const titel = `Designbeurteilung: ${ergebnis} · ${von} · ${isoDatumText(am)}${
    begruendung ? `\n${begruendung}` : ''
  }`;
  const datum = kurz ? isoDatumKurzText(am) : isoDatumText(am);
  return (
    <span className={design === 'MANGEL' ? 'badge-red' : 'badge-green'} title={titel}>
      {kurz ? '' : 'Design: '}
      {ergebnis} · {von} · {datum}
    </span>
  );
}

type DurchfuehrungKurz = Pick<
  KontrollDurchfuehrung,
  'anzeige' | 'periodeLabel' | 'faelligAm' | 'abgeschlossenAm'
>;

/** Status einer Durchführung, abgeschlossen mit Datum (z. B. „abgeschlossen – ohne Befund 20.09.“). */
export function DurchfuehrungBadge({ d }: { d: DurchfuehrungKurz }) {
  const datum =
    d.anzeige === 'OHNE_BEFUND' || d.anzeige === 'MIT_BEFUND' ? d.abgeschlossenAm : null;
  return (
    <span
      className={`${badgeKlasse(ANZEIGE_BADGE[d.anzeige])} gap-1`}
      title={`${d.periodeLabel} · fällig ${isoDatumText(d.faelligAm)}`}
    >
      {d.anzeige === 'IN_DURCHFUEHRUNG' ? (
        <CircleDot className="h-3 w-3" aria-hidden="true" />
      ) : null}
      {ANZEIGE_LABEL[d.anzeige]}
      {datum ? ` ${isoDatumKurzText(datum)}` : ''}
    </span>
  );
}

export function SchluesselBadge({ kurz }: { kurz?: boolean }) {
  return (
    <span className="badge-brand gap-1" title="Schlüsselkontrolle">
      <KeyRound className="h-3 w-3" aria-hidden="true" />
      {kurz ? <span className="sr-only">Schlüsselkontrolle</span> : 'Schlüssel'}
    </span>
  );
}
