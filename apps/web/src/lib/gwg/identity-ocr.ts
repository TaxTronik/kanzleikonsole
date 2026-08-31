/** GWG-OCR-ASSIST-001: suggestions only; this module never produces verification state. */
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

/** ICAO 9303 checksum is only an OCR consistency check, never an authenticity check. */
export function mrzCheckDigit(value: string): string {
  let total = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    const digit = char === '<' ? 0 : /[0-9]/.test(char) ? Number(char) : char.charCodeAt(0) - 55;
    if (digit < 0 || digit > 35) return '';
    total += digit * [7, 3, 1][index % 3]!;
  }
  return String(total % 10);
}

function checkMrzDates(
  second: string | undefined,
  fields: IdentitySuggestions,
  warnings: string[],
): void {
  if (second?.length !== 30 || !/^\d{6}/.test(second)) return;
  for (const [key, start] of [
    ['birthDate', 0],
    ['idExpiryDate', 8],
  ] as const) {
    const digits = second.slice(start, start + 6);
    const visual = fields[key];
    if (mrzCheckDigit(digits) !== second[start + 6]) {
      warnings.push(`Maschinenlesbares Datum (${IDENTITY_FIELD_LABELS[key]}) ist widersprüchlich.`);
    } else if (!visual) {
      // The century is not encoded. Never guess it from today's year.
      warnings.push(
        `${IDENTITY_FIELD_LABELS[key]} bitte von der ausgeschriebenen Datumsangabe übernehmen (Jahrhundert in MRZ fehlt).`,
      );
    } else if (visual.replace(/-/g, '').slice(2) !== digits) {
      warnings.push(
        `${IDENTITY_FIELD_LABELS[key]}: Sichttext und maschinenlesbares Datum widersprechen sich. Bitte am Original prüfen.`,
      );
    }
  }
}

function applyMrzSuggestions(
  lines: string[],
  fields: IdentitySuggestions,
  warnings: string[],
): void {
  const mrzLines = lines.map((line) => line.toUpperCase().replace(/\s/g, ''));
  const mrzIndex = mrzLines.findIndex((line) => /^IDD<</.test(line) && line.length === 30);
  if (mrzIndex < 0) return;
  const first = mrzLines[mrzIndex]!;
  const second = mrzLines[mrzIndex + 1];
  const third = mrzLines[mrzIndex + 2];
  const documentNumber = first.slice(5, 14);
  if (mrzCheckDigit(documentNumber) === first[14]) {
    if (fields.idNumber && fields.idNumber !== documentNumber)
      warnings.push('Widersprüchliche Ausweisnummern erkannt.');
    else fields.idNumber = documentNumber;
  } else warnings.push('Prüfziffer der maschinenlesbaren Ausweisnummer stimmt nicht.');
  checkMrzDates(second, fields, warnings);
  if (!fields.fullName && third?.length === 30 && /^[A-Z<]+$/.test(third)) {
    const [last, firstNames] = third.split('<<');
    if (last && firstNames) {
      fields.fullName = `${firstNames.replace(/</g, ' ').trim()} ${last.replace(/</g, ' ').trim()}`;
      warnings.push(
        'Name aus maschinenlesbarer Zeile: Umlaute und Schreibweise am Original prüfen.',
      );
    }
  }
}

const IDENTITY_TEXT_LABEL =
  /^(?:name|familienname|surname|nom|vornamen?|given names|pr[eé]noms|geburtstag|geburtsdatum|date of birth|geburtsort|place of birth|staatsangehörigkeit|nationality|behörde|ausstellende behörde|authority|ausgestellt am|ausstellungsdatum|date of issue|gültig bis|date of expiry|anschrift|wohnort|address)\b/i;

export function parseGermanIdentityText(text: string): IdentityOcrResult {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const fields: IdentitySuggestions = {};
  const warnings: string[] = [];
  function after(label: RegExp): string | undefined {
    const index = lines.findIndex((line) => label.test(line));
    if (index < 0) return;
    const rest = lines[index]!.replace(label, '')
      .replace(/^\s*[:/.-]\s*/, '')
      .trim();
    const candidate = rest && !IDENTITY_TEXT_LABEL.test(rest) ? rest : lines[index + 1];
    return candidate && !IDENTITY_TEXT_LABEL.test(candidate) ? candidate : undefined;
  }
  const surname = after(
    /^(?:name|familienname|surname|nom)(?:\s*\/\s*(?:name|familienname|surname|nom))*\b\s*:?\s*/i,
  );
  const given = after(
    /^(?:vornamen?|given names|pr[eé]noms)(?:\s*\/\s*(?:vornamen?|given names|pr[eé]noms))*\b\s*:?\s*/i,
  );
  if (surname && given) fields.fullName = `${given} ${surname}`;
  const plain: Array<[IdentityField, RegExp]> = [
    ['birthPlace', /^(?:geburtsort|place of birth)(?:\s*\/[^:]+)?\s*:?\s*/i],
    ['nationality', /^(?:staatsangehörigkeit|nationality)(?:\s*\/[^:]+)?\s*:?\s*/i],
    ['idIssuedBy', /^(?:behörde|ausstellende behörde|authority)(?:\s*\/[^:]+)?\s*:?\s*/i],
  ];
  for (const [key, label] of plain) {
    const value = after(label);
    if (value) fields[key] = value;
  }
  for (const [key, label] of [
    ['birthDate', /^(?:geburtstag|geburtsdatum|date of birth)\b\s*:?\s*/i],
    ['idIssueDate', /^(?:ausgestellt am|ausstellungsdatum|date of issue)\b\s*:?\s*/i],
    ['idExpiryDate', /^(?:gültig bis|date of expiry)\b\s*:?\s*/i],
  ] as const) {
    const value = after(label);
    if (value) fields[key] = isoDate(value);
  }
  const number = text.toUpperCase().match(/\b[CFGHJKLMNPRTVWXYZ][0-9CFGHJKLMNPRTVWXYZ]{8}\b/);
  if (number) fields.idNumber = number[0];
  const addressIndex = lines.findIndex((line) => /^(?:anschrift|wohnort|address)\b/i.test(line));
  if (addressIndex >= 0) {
    const address = lines.slice(addressIndex, addressIndex + 4);
    const place = address.join('\n').match(/\b(\d{5})\s+([^\n]+)/);
    if (place) {
      fields.postalCode = place[1];
      fields.city = place[2]?.trim();
    }
    const street = address.find((line) => /\b\d+[a-z]?\s*$/i.test(line) && !/^\d{5}\b/.test(line));
    if (street) fields.street = street.replace(/^(?:anschrift|wohnort|address)\s*:?\s*/i, '');
  }
  applyMrzSuggestions(lines, fields, warnings);
  for (const key of Object.keys(fields) as IdentityField[]) {
    if (!fields[key]) delete fields[key];
    else fields[key] = fields[key]!.slice(0, key === 'street' ? 255 : 200);
  }
  if (!Object.keys(fields).length)
    warnings.push('Keine sicheren Feldvorschläge erkannt. Bitte manuell erfassen.');
  return { fields, warnings };
}
