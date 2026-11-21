import type { Kennzahl } from './katalog/kontrollen';

export interface WertEintrag {
  wert: number | null;
  bemerkung: string;
  erklaert: boolean;
}

/** Erfasste Werte einer Kontrolldurchführung nach Kennzahlschlüssel. */
export type Werte = Readonly<Record<string, WertEintrag>>;

export type Toleranzlage = 'OK' | 'ERKLAERT' | 'AUSSERHALB';

const leer = (): WertEintrag => ({ wert: null, bemerkung: '', erklaert: false });

function lage(
  abweichung: number | null,
  toleranz: number | null,
  e: WertEintrag,
): Toleranzlage | null {
  if (abweichung == null) return null;
  const grenze = toleranz ?? 0;
  if (Math.abs(abweichung) <= grenze + 0.004) return 'OK';
  return e.erklaert && e.bemerkung.trim().length > 0 ? 'ERKLAERT' : 'AUSSERHALB';
}

/** Kennzahl mit berechneten Werten (Differenz, Abweichung) und Toleranzlage. */
export interface KennzahlLage {
  def: Kennzahl;
  /** Erfasster Wert bzw. berechnete Differenz (a − b, auf Cent gerundet). */
  wert: number | null;
  /** Abweichung gegen das Soll bzw. die Differenz selbst; null = keine Toleranzprüfung. */
  abweichung: number | null;
  lage: Toleranzlage | null;
  /** Differenzkennzahl (berechnet, nicht erfasst). */
  berechnet: boolean;
}

/** Toleranzlage je Kennzahl inkl. berechneter Differenzen (einzige Rechnung, auch für die Anzeige). */
export function toleranzLagen(
  defs: readonly Kennzahl[],
  werte: Werte,
  toleranzEur: number | null,
): KennzahlLage[] {
  return defs.map((def) => {
    const e = werte[def.key] ?? leer();
    if (def.differenzAus) {
      const a = werte[def.differenzAus[0]]?.wert ?? null;
      const b = werte[def.differenzAus[1]]?.wert ?? null;
      const diff = a != null && b != null ? Math.round((a - b) * 100) / 100 : null;
      return {
        def,
        wert: diff,
        abweichung: diff,
        lage: lage(diff, toleranzEur, e),
        berechnet: true,
      };
    }
    const abw =
      def.sollEur != null && e.wert != null ? Math.round((e.wert - def.sollEur) * 100) / 100 : null;
    return {
      def,
      wert: e.wert,
      abweichung: abw,
      lage: lage(abw, toleranzEur, e),
      berechnet: false,
    };
  });
}

/** Bezeichnungen erfasster Kennzahlen ohne Wert. */
export function fehlendeWerte(defs: readonly Kennzahl[], werte: Werte): string[] {
  return defs
    .filter((d) => !d.differenzAus && (werte[d.key]?.wert ?? null) == null)
    .map((d) => d.label);
}
