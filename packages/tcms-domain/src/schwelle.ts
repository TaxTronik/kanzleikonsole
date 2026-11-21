// EU-Lieferschwelle für innergemeinschaftliche Fernverkäufe (vgl. § 3c Abs. 4 UStG).
// Beträge werden in Cent (ganzzahlig) verglichen und summiert: Summen von
// Dezimalbeträgen als Gleitkommazahl liegen an der Grenze binär knapp daneben
// (4885,13 + 3513,34 + 1601,53 ergäbe 10000.000000000002).
export const EU_LIEFERSCHWELLE_EUR = 10_000;
export const WARNSTUFE = 0.8;

const SCHWELLE_CENT = EU_LIEFERSCHWELLE_EUR * 100;
const WARNSTUFE_CENT = SCHWELLE_CENT * WARNSTUFE;

export type SchwellenStatus = 'UNTERSCHRITTEN' | 'WARNUNG' | 'UEBERSCHRITTEN';

export interface SchwellenErgebnis {
  status: SchwellenStatus;
  /** Anteil des laufenden Jahres an der Schwelle (0–n). */
  anteilLfd: number;
  anteilVorjahr: number;
  label: string;
}

/** Betrag in EUR als ganze Cent (kaufmännisch gerundet). */
export function inCent(eur: number): number {
  return Math.round(eur * 100);
}

/** Summe von EUR-Beträgen, auf den Cent genau (Summe der Cent-Beträge). */
export function summeEur(betraege: Iterable<number>): number {
  let cent = 0;
  for (const b of betraege) cent += inCent(b);
  return cent / 100;
}

/** Die Schwelle gilt als überschritten, wenn sie im Vorjahr oder im laufenden Jahr überschritten ist. */
export function bewerteSchwelle(lfdEur: number, vorjahrEur: number): SchwellenErgebnis {
  const lfdCent = inCent(lfdEur);
  const vorjahrCent = inCent(vorjahrEur);
  const anteilLfd = lfdCent / SCHWELLE_CENT;
  const anteilVorjahr = vorjahrCent / SCHWELLE_CENT;
  if (lfdCent > SCHWELLE_CENT || vorjahrCent > SCHWELLE_CENT) {
    return { status: 'UEBERSCHRITTEN', anteilLfd, anteilVorjahr, label: 'Schwelle überschritten' };
  }
  if (lfdCent >= WARNSTUFE_CENT) {
    return {
      status: 'WARNUNG',
      anteilLfd,
      anteilVorjahr,
      label: `Warnung · ${Math.round(anteilLfd * 100)} %`,
    };
  }
  return { status: 'UNTERSCHRITTEN', anteilLfd, anteilVorjahr, label: 'unterschritten' };
}
