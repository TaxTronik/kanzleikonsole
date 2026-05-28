// =============================================================================
// Slugify — String → DB-/Tech-Key
//
// Behandelt deutsche Umlaute (ä → ae) und kombinierende Diakritika (NFD).
// Vorher in 5 Dateien dupliziert, leicht abweichend — jetzt ein einziger
// Helper mit Options-Object für die Varianten.
//
// Wichtig: das Diacritic-Range-Regex steht hier als `̀`–`ͯ`
// (escaped). Literal-Combining-Chars überleben UTF-8/CP1252-Roundtrips nicht
// und korrumpieren still (siehe Inzidenz beim PowerShell-Bulk-Replace).
// =============================================================================

export interface SlugifyOptions {
  /** Trennzeichen zwischen Wörtern. Default: `_`. Üblich: `_` für Tech-Keys, `-` für URLs. */
  separator?: '_' | '-';
  /** Maximale Länge. Default: 60. */
  maxLength?: number;
  /**
   * Wenn das Ergebnis nicht mit einem Buchstaben startet, wird dieser Prefix
   * vorangestellt. Sinnvoll für Identifier, die niemals mit Zahl/Symbol
   * beginnen dürfen (z. B. SQL-Spalten, JS-Variablen-Namen).
   */
  ensureLetterStart?: string;
}

const DEFAULTS: Required<SlugifyOptions> = {
  separator: '_',
  maxLength: 60,
  ensureLetterStart: '',
};

export function slugify(input: string, opts: SlugifyOptions = {}): string {
  const { separator, maxLength, ensureLetterStart } = { ...DEFAULTS, ...opts };
  const sepEscaped = separator === '-' ? '-' : '_';

  // WICHTIG: Umlaut-Mapping VOR NFD-Normalize. Sonst wird `ü` zu `u` + ̈
  // dekomponiert, der NFD-Diacritic-Stripper entfernt die ̈, und Müller wird
  // zu "muller" statt "mueller". (Genau dieser Bug schlummerte in allen
  // 5 vorigen Inline-Slugify-Implementierungen — niemandem aufgefallen.)
  let out = input
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, separator)
    .replace(new RegExp(`^${sepEscaped}+|${sepEscaped}+$`, 'g'), '');

  if (ensureLetterStart && out.length > 0 && !/^[a-z]/.test(out)) {
    out = ensureLetterStart + out;
  }

  return out.slice(0, maxLength);
}
