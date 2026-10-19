// EU-Lieferschwelle für innergemeinschaftliche Fernverkäufe (vgl. § 3c Abs. 4 UStG).
export const EU_LIEFERSCHWELLE_EUR = 10_000;
export const WARNSTUFE = 0.8;

export type SchwellenStatus = 'UNTERSCHRITTEN' | 'WARNUNG' | 'UEBERSCHRITTEN';

export interface SchwellenErgebnis {
  status: SchwellenStatus;
  /** Anteil des laufenden Jahres an der Schwelle (0–n). */
  anteilLfd: number;
  anteilVorjahr: number;
  label: string;
}

/** Die Schwelle gilt als überschritten, wenn sie im Vorjahr oder im laufenden Jahr überschritten ist. */
export function bewerteSchwelle(lfdEur: number, vorjahrEur: number): SchwellenErgebnis {
  const anteilLfd = lfdEur / EU_LIEFERSCHWELLE_EUR;
  const anteilVorjahr = vorjahrEur / EU_LIEFERSCHWELLE_EUR;
  if (anteilLfd > 1 || anteilVorjahr > 1) {
    return { status: 'UEBERSCHRITTEN', anteilLfd, anteilVorjahr, label: 'Schwelle überschritten' };
  }
  if (anteilLfd >= WARNSTUFE) {
    return {
      status: 'WARNUNG',
      anteilLfd,
      anteilVorjahr,
      label: `Warnung · ${Math.round(anteilLfd * 100)} %`,
    };
  }
  return { status: 'UNTERSCHRITTEN', anteilLfd, anteilVorjahr, label: 'unterschritten' };
}
