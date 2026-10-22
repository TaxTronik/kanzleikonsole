/**
 * GWG-OCR-ASSIST-001: Schreibweise der Ausweisvorschläge und Abgleich mit
 * bisherigen Angaben. Der Ausweis druckt Namen, Orte und Behörden in
 * Großbuchstaben, und die Erkennung verliert Umlaute. Vorschläge erscheinen in
 * üblicher Schreibweise (die Ausweisfassung bleibt sichtbar); eine bisherige
 * Angabe, die sich nur darin unterscheidet, wird nicht zum Ersetzen angeboten.
 */
import type { IdentityField, IdentitySuggestions } from './identity-ocr';

const CASED_FIELDS: ReadonlySet<IdentityField> = new Set([
  'fullName',
  'birthPlace',
  'street',
  'city',
  'idIssuedBy',
]);
// Nicht am Anfang klein: Ortsnamen, Straßen, Behörden („Frankfurt am Main“,
// „Bad Homburg v. d. Höhe“, „Unter den Linden“).
const PLACE_PARTICLES = new Set([
  'a.',
  'am',
  'an',
  'auf',
  'bei',
  'd.',
  'dem',
  'den',
  'der',
  'des',
  'im',
  'in',
  'ob',
  'und',
  'unter',
  'v.',
  'vor',
  'zum',
  'zur',
]);
// Namen nur mit deutschen Adelsprädikaten: „Van“, „Le“ oder „Du“ sind in
// vielen Namen eigenständige Bestandteile und bleiben großgeschrieben.
const NAME_PARTICLES = new Set(['von', 'vom', 'zu', 'zum', 'zur']);
const NAME_ARTICLES = new Set(['der', 'den', 'dem']);
const GERMAN_NATIONALITY = new Set(['d', 'de', 'deu', 'deutsch', 'deutschland']);

function lower(value: string): string {
  return value.toLocaleLowerCase('de-DE');
}

function isUppercaseText(value: string): boolean {
  return /\p{L}/u.test(value) && !/\p{Ll}/u.test(value.replace(/ß/g, ''));
}

/** Großschreibung am Anfang jedes Wortteils (nach Leerzeichen, -, ', /, ( oder .). */
function capitalizeParts(word: string): string {
  return word.replace(
    /(^|[\s\-'’/(.])(\p{L})/gu,
    (_, before: string, letter: string) => before + letter.toLocaleUpperCase('de-DE'),
  );
}

function naturalWords(value: string, field: IdentityField): string {
  const words = lower(value).split(' ');
  return words
    .map((word, index) => {
      if (index > 0 && field !== 'fullName' && PLACE_PARTICLES.has(word)) return word;
      if (index > 0 && field === 'fullName') {
        if (NAME_PARTICLES.has(word)) return word;
        if (NAME_ARTICLES.has(word) && NAME_PARTICLES.has(words[index - 1]!)) return word;
      }
      return capitalizeParts(word);
    })
    .join(' ');
}

/**
 * Übliche Schreibweise eines in Großbuchstaben gelesenen Vorschlags. Andere
 * Werte (gemischte Schreibung, Nummern, Daten) bleiben unverändert. Umlaute
 * und ß werden nicht ergänzt.
 */
export function naturalCase(field: IdentityField, value: string): string {
  const text = value.trim().replace(/\s+/g, ' ');
  if (!isUppercaseText(text)) return value;
  // Staatsangehörigkeit steht als Adjektiv auf dem Ausweis: „deutsch“.
  if (field === 'nationality') return lower(text);
  return CASED_FIELDS.has(field) ? naturalWords(text, field) : value;
}

function folded(value: string): string {
  return lower(value.trim().replace(/\s+/g, ' ')).replace(/ß/g, 'ss');
}

/**
 * True, wenn der Vorschlag nur in Groß-/Kleinschreibung, Leerzeichen oder in
 * Umlauten und ß abweicht, die die bisherige Angabe hat und der Ausweistext
 * verloren hat (Köln ↔ KOLN, Müller ↔ MUELLER, Heidestraße ↔ HEIDESTRASSE).
 * Ein Vorschlag mit Umlaut gegenüber einer Angabe ohne bleibt ein Unterschied.
 */
export function sameIdentityValue(
  field: IdentityField,
  existing: string,
  suggestion: string,
): boolean {
  const before = folded(existing);
  const after = folded(suggestion);
  if (before === after) return true;
  if (field === 'nationality') return GERMAN_NATIONALITY.has(before) && after === 'deutsch';
  const withoutUmlauts = before.replace(/[äöü]/g, (c) => ({ ä: 'a', ö: 'o', ü: 'u' })[c]!);
  const transliterated = before.replace(/[äöü]/g, (c) => ({ ä: 'ae', ö: 'oe', ü: 'ue' })[c]!);
  return after === withoutUmlauts || after === transliterated;
}

export interface IdentitySuggestionRow {
  field: IdentityField;
  /** Wird übernommen: übliche Schreibweise. */
  value: string;
  /** Wie auf dem Ausweis gelesen, wenn die Schreibweise angepasst wurde. */
  printed?: string;
}

/**
 * Teilt Vorschläge in anzubietende Zeilen und solche, die mit der bisherigen
 * Angabe übereinstimmen und deshalb nicht zum Ersetzen angeboten werden.
 */
export function suggestionRows(
  fields: IdentitySuggestions,
  current: IdentitySuggestions,
): { offered: IdentitySuggestionRow[]; matching: IdentityField[] } {
  const offered: IdentitySuggestionRow[] = [];
  const matching: IdentityField[] = [];
  for (const [field, printed] of Object.entries(fields) as [IdentityField, string][]) {
    if (!printed) continue;
    const existing = current[field];
    if (existing && sameIdentityValue(field, existing, printed)) {
      matching.push(field);
      continue;
    }
    const value = naturalCase(field, printed);
    offered.push(value === printed ? { field, value } : { field, value, printed });
  }
  return { offered, matching };
}
