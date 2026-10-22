/**
 * GWG-OCR-ASSIST-001: maschinenlesbare Zone (ICAO 9303, TD1) des deutschen
 * Personalausweises aus OCR-Text lesen. Prüfziffern dienen nur der
 * Konsistenz der Erkennung, nie als Echtheits- oder Identitätsprüfung.
 *
 * Tesseract liest die Füllzeichen `<` häufig als K, L, S, C oder E und
 * verwechselt T/7, Z/2, G/6, O/0, I/1, S/5, B/8. Daher:
 * - Zeilen werden an ihren festen Positionen gelesen; Füllbereiche zählen nicht.
 * - Ziffernfelder (Datum, Prüfziffer) werden auf Ziffern abgebildet.
 * - Die Ausweisnummer wird nur korrigiert, wenn genau eine Lesart ihre eigene
 *   Prüfziffer (und, falls lesbar, die Gesamtprüfziffer) erfüllt.
 * - Übernommen wird nur, was eine gültige Prüfziffer hat.
 */

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

/** Nur prüfziffergesicherte Werte; Datumsangaben als YYMMDD (ohne Jahrhundert). */
export interface IdentityMrz {
  documentNumber?: string;
  birthDate?: string;
  expiryDate?: string;
  /** Staatsangehörigkeit als Code der MRZ, z. B. „D“ (nicht prüfziffergesichert). */
  nationality?: string;
  /** Name aus Zeile 3 (keine Prüfziffer, Umlaute transliteriert). */
  surname?: string;
  givenNames?: string;
  /** Gesamtprüfziffer über Nummer, Daten und Zusatzdaten stimmt. */
  compositeValid: boolean;
}

// Ziffernfelder: Buchstaben, die Tesseract für Ziffern hält.
const AS_DIGIT: Record<string, string> = {
  O: '0',
  Q: '0',
  D: '0',
  U: '0',
  I: '1',
  L: '1',
  Z: '2',
  S: '5',
  G: '6',
  T: '7',
  B: '8',
};
// Ausweisnummern bestehen aus Ziffern und den Konsonanten C F G H J K L M N P R
// T V W X Y Z. Vokale und S/B/D/Q kommen nicht vor und sind sicher Ziffern.
const DOCUMENT_AS_DIGIT: Record<string, string> = {
  O: '0',
  Q: '0',
  D: '0',
  U: '0',
  I: '1',
  S: '5',
  B: '8',
};
// Beide Lesarten sind in Ausweisnummern zulässig; nur Prüfziffern entscheiden.
// G/6 fehlt bewusst: G (16) und 6 unterscheiden sich um 10, die Prüfziffer
// bleibt gleich – diese Verwechslung kann keine Prüfziffer auflösen.
const DOCUMENT_AMBIGUOUS: Record<string, string> = {
  T: '7',
  '7': 'T',
  Z: '2',
  '2': 'Z',
};

const digits = (value: string) => value.replace(/[A-Z]/g, (char) => AS_DIGIT[char] ?? char);

/** Großbuchstaben, ohne Leerzeichen; « und ‹ sind gelesene Füllzeichen. */
export function normalizeMrzLine(line: string): string {
  return line.toUpperCase().replace(/[«‹]/g, '<').replace(/\s+/g, '');
}

function isMrzLike(line: string): boolean {
  if (line.length < 26) return false;
  const valid = line.replace(/[^A-Z0-9<]/g, '').length;
  return valid / line.length >= 0.9 && /</.test(line);
}

function validYymmdd(value: string): boolean {
  if (!/^\d{6}$/.test(value)) return false;
  const month = Number(value.slice(2, 4));
  const day = Number(value.slice(4, 6));
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/** Lesarten der Ausweisnummer mit Zahl der Änderungen; die gelesene Fassung zuerst. */
function documentCandidates(raw: string): Array<{ value: string; changes: number }> {
  const base = [...raw].map((char) => DOCUMENT_AS_DIGIT[char] ?? char);
  const ambiguous = base.flatMap((char, index) => (DOCUMENT_AMBIGUOUS[char] ? [index] : []));
  // Höchstens 2^6 Lesarten; bei mehr Unsicherheit nur die gelesene Fassung.
  if (ambiguous.length > 6) return [{ value: base.join(''), changes: 0 }];
  const result: Array<{ value: string; changes: number }> = [];
  for (let mask = 0; mask < 1 << ambiguous.length; mask++) {
    const chars = [...base];
    let changes = 0;
    ambiguous.forEach((position, bit) => {
      if (mask & (1 << bit)) {
        chars[position] = DOCUMENT_AMBIGUOUS[chars[position]!]!;
        changes++;
      }
    });
    result.push({ value: chars.join(''), changes });
  }
  return result;
}

/** Eindeutige Lesart mit den wenigsten Änderungen, sonst keine. */
function fewestChanges(list: Array<{ value: string; changes: number }>): string | undefined {
  if (!list.length) return;
  const min = Math.min(...list.map((entry) => entry.changes));
  const best = list.filter((entry) => entry.changes === min);
  return best.length === 1 ? best[0]!.value : undefined;
}

function parseName(line: string): { surname?: string; givenNames?: string } {
  const separator = line.indexOf('<<');
  if (separator <= 0) return {};
  const surname = line.slice(0, separator).replace(/</g, ' ').trim();
  // Vornamen enden am nächsten Doppel-Füllzeichen; Rest sind Füllzeichen. Als
  // Buchstaben gelesene Füllzeichen erscheinen als Einzelzeichen oder Folgen
  // wie „SSSSSES“ und beenden die Vornamen ebenfalls.
  const parts = line
    .slice(separator + 2)
    .split('<<')[0]!
    .split('<')
    .filter(Boolean);
  const junk = parts.findIndex((part) => part.length === 1 || /(.)\1\1/.test(part));
  const given = junk < 0 ? parts : parts.slice(0, junk);
  if (!/^[A-Z ]+$/.test(surname) || !given.length || !given.every((part) => /^[A-Z]+$/.test(part)))
    return {};
  return { surname, givenNames: given.join(' ') };
}

/** Zeile 2: Daten und Staatsangehörigkeit, nur mit gültiger Prüfziffer. */
function readSecondLine(
  second: string,
): Pick<IdentityMrz, 'birthDate' | 'expiryDate' | 'nationality'> {
  const result: Pick<IdentityMrz, 'birthDate' | 'expiryDate' | 'nationality'> = {};
  const birth = digits(second.slice(0, 6));
  if (validYymmdd(birth) && mrzCheckDigit(birth) === digits(second[6] ?? ''))
    result.birthDate = birth;
  const expiry = digits(second.slice(8, 14));
  if (validYymmdd(expiry) && mrzCheckDigit(expiry) === digits(second[14] ?? ''))
    result.expiryDate = expiry;
  const nationality = second
    .slice(15, 18)
    .replace(/[<KLSCE]+$/, '')
    .replace(/<.*$/, '');
  if (/^[A-Z]{1,3}$/.test(nationality)) result.nationality = nationality;
  return result;
}

/**
 * Ausweisnummer aus Zeile 1. Vorrang hat, was auch die Gesamtprüfziffer
 * erfüllt, dann die eigene Prüfziffer; jeweils die Lesart mit den wenigsten
 * Änderungen (die gelesene Fassung zuerst). Bleibt es mehrdeutig: keine.
 */
function readDocumentNumber(
  first: string,
  second: string,
  dates: Pick<IdentityMrz, 'birthDate' | 'expiryDate'>,
): { documentNumber?: string; compositeValid: boolean } {
  const documentCheck = digits(first[14] ?? '');
  const valid = documentCandidates(first.slice(5, 14)).filter(
    ({ value }) => /^[0-9A-Z]{9}$/.test(value) && mrzCheckDigit(value) === documentCheck,
  );
  // Gesamtprüfziffer (TD1): Zeile 1 ab Nummer, Daten mit Prüfziffern,
  // Zusatzdaten. Beim deutschen Ausweis sind die Zusatzdaten in Zeile 1 leer.
  const readable = second.length === 30 && dates.birthDate && dates.expiryDate;
  const compositeOf = (number: string) =>
    Boolean(readable) &&
    mrzCheckDigit(
      `${number}${documentCheck}${'<'.repeat(15)}${dates.birthDate}${digits(second[6]!)}${dates.expiryDate}${digits(second[14]!)}${second.slice(18, 29).replace(/[KLSCE]/g, '<')}`,
    ) === digits(second[29] ?? '');
  const chosen =
    fewestChanges(valid.filter(({ value }) => compositeOf(value))) ?? fewestChanges(valid);
  return chosen
    ? { documentNumber: chosen, compositeValid: compositeOf(chosen) }
    : { compositeValid: false };
}

/**
 * Name nur aus einer Zeile direkt nach einer Zeile 2 (auch aus einer weiteren
 * Lesart); davon die mit den saubersten Füllzeichen. Andere Zeilen mit „<<“
 * (etwa die Nummernzeile über der Zone) sind kein Name.
 */
function readName(lines: string[], from: number): { surname?: string; givenNames?: string } {
  const names = lines.flatMap((line, index) =>
    index > from &&
    /^\d{6}/.test(digits(lines[index - 1]!.slice(0, 6))) &&
    /^[A-Z]+(?:<[A-Z]+)*<<[A-Z]/.test(line) &&
    !/\d/.test(line)
      ? [line]
      : [],
  );
  return (
    names
      .map((line) => ({ line, fill: (line.match(/</g) ?? []).length }))
      .sort((a, b) => b.fill - a.fill)
      .map(({ line }) => parseName(line))
      .find((parsed) => parsed.surname) ?? {}
  );
}

/**
 * Liest die beste TD1-Zone (deutscher Personalausweis, „IDD“) aus OCR-Zeilen.
 * Mehrere Lesarten dürfen dieselbe Zone liefern; gewählt wird die mit den
 * meisten gültigen Prüfziffern, beim Namen die mit den saubersten Füllzeichen.
 */
export function parseGermanTd1(lines: string[]): IdentityMrz | null {
  const normalized = lines.map(normalizeMrzLine).filter(isMrzLike);
  let best: { mrz: IdentityMrz; score: number } | null = null;
  normalized.forEach((first, index) => {
    if (!/^[I1][D0O][D0O]/.test(first)) return;
    const second = normalized
      .slice(index + 1, index + 3)
      .find((line) => /^\d{6}$/.test(digits(line.slice(0, 6))));
    if (!second) return;
    const dates = readSecondLine(second);
    const document = readDocumentNumber(first, second, dates);
    const mrz: IdentityMrz = { ...dates, ...document, ...readName(normalized, index) };
    if (!mrz.documentNumber) delete mrz.documentNumber;
    const score =
      Number(Boolean(mrz.birthDate)) +
      Number(Boolean(mrz.expiryDate)) +
      Number(Boolean(mrz.documentNumber)) +
      Number(mrz.compositeValid);
    if (score > 0 && (!best || score > best.score)) best = { mrz, score };
  });
  return (best as { mrz: IdentityMrz } | null)?.mrz ?? null;
}
