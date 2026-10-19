// =============================================================================
// Eingabe von Beträgen in Kontrollaufgaben (TCMS Stufe 3, Bereich D; aus der
// Demo components/durchfuehrung/werte.ts, nur der Eingabeteil). Reine
// Umwandlung deutscher Dezimaleingaben – keine Toleranz- oder Differenz-
// rechnung: Ob ein Wert außerhalb der Toleranz liegt und wie Differenzen
// lauten, sagt das Tax-CMS (`pruefung` der Antwort).
// =============================================================================

/** Vertragsgrenze für Beträge (DF_MAX_BETRAG, Euro, exklusiv). */
const MAX_BETRAG = 1e12;

/**
 * Deutsche Dezimaleingabe („412.380,15“, „-12,5“, „0“) → Zahl mit zwei
 * Nachkommastellen. Leer → null; unlesbar oder zu groß → 'fehler'.
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

/** Dateigröße kompakt in de-DE. */
export function groesseText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} KB`;
  }
  return `${(bytes / 1024 / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`;
}
