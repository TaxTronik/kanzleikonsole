// =============================================================================
// Kennzahlen einer Kontrolldurchführung (TCMS Stufe 3, Bereich C; portiert aus
// der Demo components/durchfuehrung/werte.ts). Reine Helfer ohne I/O für die
// Werte-Tabelle und das Lesen der Beträge im Formular. Differenzen,
// Abweichungen und Toleranzlage berechnet seit TCMS s7 nur der Dienst
// (`pruefung.kennzahlen` des gespeicherten Stands); die Seiten zeigen diese
// Werte an und rechnen nichts nach (vorher eine Anzeige-Vorschau im Browser).
// Eingabe und Formatierung (parseDezimal, alsEingabe, fmtGroesse) und die
// Zeilen der Tabelle nutzen Kanzlei (Bereich C) und Portal (Bereich D).
// =============================================================================

export interface KennzahlDef {
  key: string;
  label: string;
  /** Sollwert in Euro (z. B. 0 für Clearingkonten); null = kein Soll. */
  sollEur: number | null;
  /** Differenzkennzahl aus zwei erfassten Werten (a − b). */
  differenzAus?: readonly [string, string] | undefined;
}

export interface WertEintrag {
  wert: number | null;
  bemerkung: string;
  erklaert: boolean;
}

export type Werte = Record<string, WertEintrag>;

/** Lage einer Abweichung zur Toleranz der Kontrolle. */
export type Toleranzlage = 'OK' | 'ERKLAERT' | 'AUSSERHALB';

export interface WertZeile {
  def: KennzahlDef;
  /** Erfasster Wert bzw. berechnete Differenz. */
  wert: number | null;
  /** Abweichung gegen Soll bzw. Differenz; null = keine Toleranzprüfung. */
  abweichung: number | null;
  lage: Toleranzlage | null;
  bemerkung: string;
  erklaert: boolean;
  berechnet: boolean;
}

export function leererEintrag(): WertEintrag {
  return { wert: null, bemerkung: '', erklaert: false };
}

/** Werte aus der Liste des Vertrags (`werte: [{ key, … }]`) als Nachschlagetabelle. */
export function werteAusListe(
  liste: ReadonlyArray<{ key: string; wert: number | null; bemerkung: string; erklaert: boolean }>,
): Werte {
  const out: Werte = Object.create(null) as Werte;
  for (const w of liste)
    out[w.key] = { wert: w.wert, bemerkung: w.bemerkung, erklaert: w.erklaert };
  return out;
}

/** Vertragsgrenze für Beträge (DF_MAX_BETRAG des Vertrags, Euro, exklusiv). */
const MAX_BETRAG = 1e12;

/**
 * Deutsche Dezimaleingabe („412.380,15", „-12,5", „0") → Zahl mit zwei
 * Nachkommastellen. Leer → null; unlesbar oder zu groß → 'fehler'. Eine
 * Umwandlung für Kanzlei (Durchführung, Feststellung) und Portal
 * (Kontrollaufgabe); Integration TCMS Stufe 3.
 */
export function parseDezimal(eingabe: string): number | null | 'fehler' {
  let s = eingabe.replace(/[\s\u00a0\u20ac]/g, '');
  if (s === '') return null;
  s = s.replace(/^[\u2212\u2013]/, '-');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return 'fehler';
  const n = Number(s);
  if (!Number.isFinite(n) || Math.abs(n) >= MAX_BETRAG) return 'fehler';
  return Math.round(n * 100) / 100;
}

/** Zahl → Eingabetext im de-DE-Format ohne Tausenderpunkte. */
export function alsEingabe(n: number | null | undefined): string {
  if (n == null) return '';
  return n.toFixed(2).replace('.', ',');
}

/** Kennzahl der Prüfung des Dienstes (`pruefung.kennzahlen`, TCMS s7). */
export interface KennzahlPruefung {
  key: string;
  wert: number | null;
  abweichung: number | null;
  lage: Toleranzlage | null;
  berechnet: boolean;
}

/**
 * Zeilen der Werte-Tabelle: Aufbau der Kontrolle (`defs`), Bemerkungen aus den
 * gespeicherten Werten, Wert, Abweichung und Toleranzlage aus der Prüfung des
 * Dienstes. Fehlt eine Kennzahl in der Prüfung, bleiben Abweichung und Lage
 * leer (keine eigene Rechnung).
 */
export function werteZeilen(
  defs: readonly KennzahlDef[],
  werte: Werte,
  pruefung: readonly KennzahlPruefung[],
): WertZeile[] {
  const jeKey = new Map(pruefung.map((k) => [k.key, k] as const));
  return defs.map((def) => {
    const e = werte[def.key] ?? leererEintrag();
    const p = jeKey.get(def.key);
    return {
      def,
      wert: p ? p.wert : def.differenzAus ? null : e.wert,
      abweichung: p?.abweichung ?? null,
      lage: p?.lage ?? null,
      bemerkung: e.bemerkung,
      erklaert: e.erklaert,
      berechnet: p?.berechnet ?? def.differenzAus != null,
    };
  });
}

export const LAGE_TEXT: Readonly<Record<Toleranzlage, string>> = {
  OK: 'innerhalb Toleranz',
  ERKLAERT: 'Differenz erklärt',
  AUSSERHALB: 'außerhalb Toleranz',
};

export const LAGE_BADGE: Readonly<Record<Toleranzlage, string>> = {
  OK: 'badge-green',
  ERKLAERT: 'badge-yellow',
  AUSSERHALB: 'badge-red',
};

/** Dateigröße kompakt in de-DE. */
export function fmtGroesse(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} KB`;
  return `${(bytes / 1024 / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`;
}

/** Kurzform der Periode für die Spaltenüberschrift („September 2026“ → „Sep 2026“). */
export function periodeKurz(label: string): string {
  const m = /^([A-Za-zÄÖÜäöü]+) (\d{4})/.exec(label);
  return m && m[1]!.length > 3 ? `${m[1]!.slice(0, 3)} ${m[2]}` : label.replace(' · Nachtrag', '');
}
