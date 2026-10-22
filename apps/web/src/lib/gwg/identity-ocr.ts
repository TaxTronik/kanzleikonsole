/** GWG-OCR-ASSIST-001: suggestions only; this module never produces verification state. */
import { mrzCheckDigit, parseGermanTd1, type IdentityMrz } from './identity-mrz';

export { mrzCheckDigit };
export type { IdentityMrz };

export const IDENTITY_FIELD_LABELS = {
  fullName: 'Vollständiger Name',
  birthDate: 'Geburtsdatum',
  birthPlace: 'Geburtsort',
  nationality: 'Staatsangehörigkeit',
  street: 'Straße',
  postalCode: 'PLZ',
  city: 'Ort',
  idNumber: 'Ausweisnummer',
  idIssuedBy: 'Ausstellende Behörde',
  idIssueDate: 'Ausgestellt am',
  idExpiryDate: 'Gültig bis',
} as const;
export type IdentityField = keyof typeof IDENTITY_FIELD_LABELS;
export type IdentitySuggestions = Partial<Record<IdentityField, string>>;
export interface IdentityOcrResult {
  fields: IdentitySuggestions;
  warnings: string[];
  /**
   * Prüfziffergesicherte Werte der maschinenlesbaren Zone (Daten als YYMMDD),
   * nur für den Abgleich mit der anderen Ausweisseite bzw. bisherigen Angaben.
   */
  mrz?: Pick<IdentityMrz, 'documentNumber' | 'birthDate' | 'expiryDate'>;
}

function isoDate(text: string): string | undefined {
  const match = text.match(/\b(\d{2})[. /-](\d{2})[. /-](\d{4})\b/);
  if (!match) return;
  const iso = `${match[3]}-${match[2]}-${match[1]}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso
    ? iso
    : undefined;
}

/**
 * Warnungen, wenn Angaben der prüfziffergesicherten MRZ widersprechen. Auch für
 * den Abgleich zwischen Vorder- und Rückseite in der Erfassung. Leitet nie ein
 * Jahrhundert ab und ersetzt keinen Wert.
 */
export function compareWithMrz(
  fields: IdentitySuggestions,
  mrz: NonNullable<IdentityOcrResult['mrz']>,
): string[] {
  const warnings: string[] = [];
  for (const [key, value] of [
    ['birthDate', mrz.birthDate],
    ['idExpiryDate', mrz.expiryDate],
  ] as const) {
    const visual = fields[key];
    if (value && visual && visual.replace(/-/g, '').slice(2) !== value)
      warnings.push(
        `${IDENTITY_FIELD_LABELS[key]}: Sichttext und maschinenlesbares Datum widersprechen sich. Bitte am Original prüfen.`,
      );
  }
  if (mrz.documentNumber && fields.idNumber && fields.idNumber !== mrz.documentNumber)
    warnings.push(
      `Ausweisnummer: ${fields.idNumber} widerspricht der maschinenlesbaren Zone (${mrz.documentNumber}). Bitte am Original prüfen.`,
    );
  return warnings;
}

function applyMrzSuggestions(
  lines: string[],
  fields: IdentitySuggestions,
  warnings: string[],
): IdentityOcrResult['mrz'] {
  const mrz = parseGermanTd1(lines);
  if (!mrz) {
    if (lines.some((line) => /^[I1][D0O][D0O]/.test(line.replace(/\s/g, '').toUpperCase())))
      warnings.push('Prüfziffer der maschinenlesbaren Ausweisnummer stimmt nicht.');
    return;
  }
  warnings.push(...compareWithMrz(fields, mrz));
  if (mrz.documentNumber) {
    // Gültige Prüfziffer schlägt den ungesicherten Sichttext; der Widerspruch ist gewarnt.
    fields.idNumber = mrz.documentNumber;
  } else warnings.push('Prüfziffer der maschinenlesbaren Ausweisnummer stimmt nicht.');
  for (const [key, value] of [
    ['birthDate', mrz.birthDate],
    ['idExpiryDate', mrz.expiryDate],
  ] as const) {
    // The century is not encoded. Never guess it from today's year.
    if (value && !fields[key])
      warnings.push(
        `${IDENTITY_FIELD_LABELS[key]} bitte von der ausgeschriebenen Datumsangabe übernehmen (Jahrhundert in MRZ fehlt).`,
      );
  }
  if (!fields.nationality && mrz.nationality === 'D') fields.nationality = 'DEUTSCH';
  if (!fields.fullName && mrz.surname && mrz.givenNames) {
    fields.fullName = `${mrz.givenNames} ${mrz.surname}`;
    warnings.push('Name aus maschinenlesbarer Zeile: Umlaute und Schreibweise am Original prüfen.');
  }
  return {
    ...(mrz.documentNumber && { documentNumber: mrz.documentNumber }),
    ...(mrz.birthDate && { birthDate: mrz.birthDate }),
    ...(mrz.expiryDate && { expiryDate: mrz.expiryDate }),
  };
}

// Beschriftungen am Zeilenanfang (nach Entfernen der Marker „[a]“/„[b]“).
const LABEL = {
  surname:
    /^(?:name|familienname|surname|nom)(?:\s*\/\s*(?:name|familienname|surname|nom))*\b\s*:?\s*/i,
  birthName: /^(?:geburtsname|name at birth|nom de naissance)\b/i,
  given:
    /^(?:vornamen?|given names|pr[eé]noms)(?:\s*\/\s*(?:vornamen?|given names|pr[eé]noms))*\b\s*:?\s*/i,
  birthDate: /^(?:geburtstag|geburtsdatum|date of birth)\b\s*:?\s*/i,
  birthPlace: /^(?:geburtsort|place of birth)(?:\s*\/[^:]+)?\s*:?\s*/i,
  nationality: /^(?:staatsangeh\S{1,2}rigkeit|nationality)(?:\s*\/[^:]+)?\s*:?\s*/i,
  // OCR liest das ö in „Behörde“ oft als d, o oder 6.
  issuedBy: /^(?:ausstellende\s+)?(?:beh\S{1,2}rde|authority)(?:\s*\/[^:]+)?\s*:?\s*/i,
  issueDate: /^(?:ausgestellt am|ausstellungsdatum|date of issue|datum(?=\s*[/:]|\s*$))\b\s*:?\s*/i,
  expiry: /^(?:g[üu]ltig bis|date of expiry)\b\s*:?\s*/i,
};
// Fortsetzungen der mehrsprachigen bzw. zweispaltigen Beschriftungen.
const COMPANION = {
  surname: LABEL.birthName,
  birthDate: /^(?:date de naissance|nationalit|staatsangeh)/i,
  birthPlace: /^lieu de naissance/i,
  expiry: /^date d.?expiration/i,
  issuedBy: /^autorit/i,
};
const ANY_LABEL = new RegExp(
  `^(?:${[
    'name\\b',
    'familienname\\b',
    'surname\\b',
    'nom\\b',
    'geburtsname\\b',
    'vornamen?\\b',
    'given names\\b',
    'pr[eé]noms\\b',
    'geburtstag\\b',
    'geburtsdatum\\b',
    'date of birth',
    'date de naissance',
    'geburtsort\\b',
    'place of birth',
    'lieu de naissance',
    'staatsangeh',
    'nationalit',
    'ausstellende\\b',
    'beh\\S{1,2}rde\\b',
    'authority\\b',
    'autorit',
    'ausgestellt\\b',
    'ausstellungsdatum\\b',
    'date of issue',
    'datum\\b',
    'g[üu]ltig bis',
    'date of expiry',
    'date d.?expiration',
    'anschrift\\b',
    'wohnort\\b',
    'address\\b',
    'adresse\\b',
    'augenfarbe\\b',
    'gr\\S{1,2}e\\b',
    'height\\b',
  ].join('|')})`,
  'i',
);

/** Beschriftungen sind gemischt geschrieben („Name“), Werte in Versalien („NOMURA“). */
function isLabel(line: string): boolean {
  return ANY_LABEL.test(line) && !/^[A-ZÄÖÜ]{3,}(?:\s|$)/.test(line);
}

/** „[a]“-/„[b]“-Marker vor Beschriftungen und Werten (OCR: „aI“, „[a]“, „(a)“). */
function stripMarker(line: string): string {
  return line.replace(/^\s*(?:[[(|]\s*[ab]\s*[\])|Il1]|a[\]|Il1](?=[A-ZÄÖÜ]))\s*/, '');
}

/**
 * Werte auf deutschen Ausweisen stehen in Großbuchstaben. Randtoken mit
 * Kleinbuchstaben oder ohne Buchstaben/Ziffern stammen aus Hintergrund,
 * Hologramm oder Fotokante und werden entfernt.
 */
function cleanValue(value: string): string {
  const tokens = value
    .replace(/[|©®«»“”"`´^~_]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const valid = (token: string) => /^[A-ZÄÖÜ0-9][A-ZÄÖÜß0-9.\-,'/]*$/.test(token);
  while (tokens.length && !valid(tokens.at(-1)!)) tokens.pop();
  while (tokens.length && !valid(tokens[0]!)) tokens.shift();
  return tokens.join(' ').replace(/[-.,/]+$/, '');
}

const meaningful = (value: string) => /[A-ZÄÖÜ]{2,}|\d{2,}/.test(value);

/**
 * Wert hinter einer Beschriftung: in derselben Zeile oder in den nächsten
 * Zeilen; Fortsetzungen derselben Beschriftung werden übersprungen, eine
 * fremde Beschriftung beendet die Suche.
 */
function valueAfter(lines: string[], label: RegExp, companion?: RegExp): string | undefined {
  const index = lines.findIndex((line) => label.test(line));
  if (index < 0) return;
  const rest = cleanValue(lines[index]!.replace(label, '').replace(/^[\s:/.\-|]+/, ''));
  if (rest && meaningful(rest) && !isLabel(rest)) return rest;
  for (let next = index + 1; next < Math.min(lines.length, index + 4); next++) {
    const line = lines[next]!;
    if (isLabel(line)) {
      if (companion?.test(line)) continue;
      return;
    }
    const value = cleanValue(line);
    if (meaningful(value)) return value;
  }
}

/** Datum hinter einer Beschriftung; steht schon ein Datumsversuch in der Zeile, zählt nur sie. */
function dateAfter(lines: string[], label: RegExp, companion?: RegExp): string | undefined {
  const index = lines.findIndex((line) => label.test(line));
  if (index < 0) return;
  const own = lines[index]!.replace(label, '');
  if (/\d{2}[. /-]\d{2}/.test(own)) return isoDate(own);
  for (let next = index + 1; next < Math.min(lines.length, index + 4); next++) {
    const line = lines[next]!;
    if (isLabel(line) && !companion?.test(line)) return;
    const date = isoDate(line);
    if (date) return date;
  }
}

function textFields(lines: string[], fields: IdentitySuggestions): void {
  const surname = valueAfter(lines, LABEL.surname, COMPANION.surname);
  const given = valueAfter(lines, LABEL.given);
  if (surname && given) fields.fullName = `${given} ${surname}`;
  fields.birthPlace = valueAfter(lines, LABEL.birthPlace, COMPANION.birthPlace);
  fields.idIssuedBy = valueAfter(lines, LABEL.issuedBy, COMPANION.issuedBy);
}

function dateFields(lines: string[], fields: IdentitySuggestions, warnings: string[]): void {
  fields.birthDate = dateAfter(lines, LABEL.birthDate, COMPANION.birthDate);
  fields.idExpiryDate = dateAfter(lines, LABEL.expiry, COMPANION.expiry);
  fields.idIssueDate = dateAfter(lines, LABEL.issueDate);
  if (fields.idIssueDate) return;
  // Auf dem Ausweis steht das Ausstellungsdatum mit zweistelliger Jahreszahl;
  // ein Jahrhundert wird nicht geraten (wie bei der MRZ).
  const issueIndex = lines.findIndex((line) => LABEL.issueDate.test(line));
  if (
    issueIndex >= 0 &&
    lines
      .slice(issueIndex, issueIndex + 3)
      .some((line) => /\b\d{2}\.\d{2}\.\d{2}\b(?!\.?\d)/.test(line))
  )
    warnings.push(
      'Ausgestellt am steht mit zweistelliger Jahreszahl auf dem Ausweis. Bitte vom Original übernehmen.',
    );
}

/**
 * Staatsangehörigkeit: eigene Zeile oder zweite Spalte neben dem Geburtstag.
 * Übernommen wird nur eine Angabe in Adjektivform (DEUTSCH, …ISCH).
 */
function nationalityField(lines: string[]): string | undefined {
  const label = /staatsangeh\S{1,2}rigkeit|nationality/i;
  const index = lines.findIndex((line) => label.test(line));
  if (index < 0) return;
  for (let next = index; next < Math.min(lines.length, index + 4); next++) {
    const line =
      next === index
        ? lines[next]!.replace(
            /^.*?(?:staatsangeh\S{1,2}rigkeit|nationality)(?:\s*\/[^:]*)?\s*:?\s*/i,
            '',
          )
        : lines[next]!;
    const word = cleanValue(line.replace(/\d{2}[. /-]\d{2}[. /-]\d{2,4}/g, ' '))
      .split(' ')
      .find((token) => /^(?:DEUTSCH|[A-ZÄÖÜ]{3,}ISCH)$/.test(token));
    if (word) return word;
  }
}

/** Ausweisnummer im Sichttext; nie aus MRZ-Zeilen und nie ohne Ziffern („LKLKKLKLK“). */
function visualIdNumber(lines: string[]): string | undefined {
  for (const line of lines) {
    if (/</.test(line)) continue;
    const number = line
      .toUpperCase()
      .match(/\b[CFGHJKLMNPRTVWXYZ][0-9CFGHJKLMNPRTVWXYZ]{8}\b/g)
      ?.find((candidate) => (candidate.match(/\d/g) ?? []).length >= 3);
    if (number) return number;
  }
}

/** Anschrift: die Beschriftung kann in der zweiten Spalte einer Zeile stehen. */
function addressFields(lines: string[], fields: IdentitySuggestions): void {
  const index = lines.findIndex((line) => /\b(?:anschrift|wohnort|address)\b/i.test(line));
  if (index < 0) return;
  const block = lines.slice(index, index + 5);
  const place = block
    .map((line) => line.match(/\b(\d{5})\s+([A-ZÄÖÜ][A-ZÄÖÜß\- ]*)/))
    .find(Boolean);
  if (place) {
    fields.postalCode = place[1];
    fields.city = cleanValue(place[2]!);
  }
  fields.street = block
    .map((line) => cleanValue(line.replace(/^(?:anschrift|wohnort|address)\b\s*:?\s*/i, '')))
    .find(
      (line) =>
        /[A-ZÄÖÜß]{3,}.*\s\d+\s?[A-Z]?$/i.test(line) &&
        !/^\d{5}\b/.test(line) &&
        !/\bcm\b/i.test(line) &&
        !isLabel(line),
    );
}

export function parseGermanIdentityText(text: string): IdentityOcrResult {
  const lines = text
    .split(/\r?\n/)
    .map((line) => stripMarker(line.trim()))
    .filter(Boolean);
  const fields: IdentitySuggestions = {};
  const warnings: string[] = [];
  textFields(lines, fields);
  dateFields(lines, fields, warnings);
  fields.nationality = nationalityField(lines);
  fields.idNumber = visualIdNumber(lines);
  addressFields(lines, fields);
  const mrz = applyMrzSuggestions(lines, fields, warnings);
  for (const key of Object.keys(fields) as IdentityField[]) {
    if (!fields[key]) delete fields[key];
    else fields[key] = fields[key]!.slice(0, key === 'street' ? 255 : 200);
  }
  if (!Object.keys(fields).length)
    warnings.push('Keine sicheren Feldvorschläge erkannt. Bitte manuell erfassen.');
  return mrz && Object.keys(mrz).length ? { fields, warnings, mrz } : { fields, warnings };
}
