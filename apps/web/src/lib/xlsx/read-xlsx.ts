// =============================================================================
// Lesender XLSX-Parser (SpreadsheetML) auf Basis von `fflate`.
//
// Ersetzt ExcelJS: Wir schreiben keine Arbeitsmappen, sondern lesen nur
// DATEV-/ADDISON-Exporte und zeigen Mandanten-Uploads in der Vorschau. ExcelJS
// selbst ist weder abgekuendigt noch deprecated, hat aber seit 4.4.0 (2023) kein
// stabiles Release mehr und zog archiver/unzipper/fstream/rimraf/glob@7 nach —
// von npm als deprecated gemeldete Pfade. Ueber sie kam GHSA-mh99-v99m-4gvg
// (brace-expansion) in den Prod-Graph, das sich nicht per Override loesen liess:
// die Advisory-Range deckt alle Zweige ab, fuer 1.x gab es keinen Backport, und
// ein Force auf 5.x bricht minimatch 3/5.
//
// Unterstuetzt: Shared Strings, Inline-Strings, Formeln (zwischengespeichertes
// Ergebnis), Wahrheitswerte, Fehlerzellen, Datums-/Zeitformate ueber styles.xml,
// Luecken in Zeilen und Spalten. Nicht unterstuetzt: Formatierung, Formeln neu
// berechnen, Diagramme, Pivot-Tabellen.
// =============================================================================

import { unzipSync, strFromU8 } from 'fflate';
import { parseXml } from './xml';

export type XlsxValue = string | number | boolean | Date | null;

export interface XlsxSheet {
  name: string;
  /** Zeilen-Raster, 0-basiert. Luecken sind `null`, alle Zeilen gleich breit. */
  rows: XlsxValue[][];
}

/** Grenzen aus ECMA-376; darueber ist die Datei nicht mehr Excel-konform. */
const MAX_ROWS = 1_048_576;
const MAX_COLUMNS = 16_384;

/**
 * Obergrenze fuer das materialisierte Raster. Eine praeparierte Datei kann mit
 * wenigen Bytes eine Zelle bei `XFD1048576` deklarieren; ohne Budget wuerde das
 * Raster den Prozess sprengen. Uploads stammen von Mandanten — also nicht
 * vertrauenswuerdig.
 */
const MAX_CELLS = 4_000_000;

/**
 * Entpack-Budget. `unzipSync` ohne Filter entpackt JEDEN Eintrag und allokiert
 * vorab die im Central Directory deklarierte Originalgroesse — das Zellbudget
 * oben greift erst auf dem bereits entpackten XML, also viel zu spaet. Eine
 * wenige Kilobyte grosse Datei kann so Gigabyte anfordern (Zip-Bombe).
 *
 * Der Filter laeuft VOR der Allokation, deshalb ist die deklarierte Groesse
 * hier das richtige Signal: wir lehnen ab, bevor der Speicher angefordert wird.
 */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;

/**
 * Nur die Teile, die dieser Reader auswertet. Alles andere — eingebettete
 * Bilder unter `xl/media/`, OLE-Objekte, Drucker-Einstellungen — wird gar nicht
 * erst dekomprimiert. Sheet-Pfade stehen erst nach dem Lesen der Relationships
 * fest, deshalb `xl/**\/*.xml` statt einer festen Liste. Die Workbook-
 * Relationships selbst enden auf `.rels` und müssen ebenfalls gelesen werden.
 */
function isNeededEntry(name: string): boolean {
  if (name === '[Content_Types].xml') return true;
  if (name === 'xl/_rels/workbook.xml.rels') return true;
  return name.startsWith('xl/') && name.toLowerCase().endsWith('.xml');
}

export class XlsxReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XlsxReadError';
  }
}

export function readXlsx(data: Uint8Array | ArrayBuffer): XlsxSheet[] {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);

  let files: Record<string, Uint8Array>;
  let budgetError: XlsxReadError | null = null;
  let totalBytes = 0;
  try {
    files = unzipSync(bytes, {
      filter: (entry) => {
        if (!isNeededEntry(entry.name)) return false;
        if (entry.originalSize > MAX_ENTRY_BYTES) {
          budgetError ??= new XlsxReadError(
            `Eintrag "${entry.name}" ist mit ${entry.originalSize} Byte zu gross.`,
          );
          return false;
        }
        totalBytes += entry.originalSize;
        if (totalBytes > MAX_TOTAL_BYTES) {
          budgetError ??= new XlsxReadError('Arbeitsmappe sprengt das Entpack-Budget.');
          return false;
        }
        return true;
      },
    });
  } catch (cause) {
    throw new XlsxReadError(`XLSX-Container nicht lesbar: ${(cause as Error).message}`);
  }
  if (budgetError) throw budgetError;

  const workbookXml = readEntry(files, 'xl/workbook.xml');
  if (workbookXml === null) {
    throw new XlsxReadError('xl/workbook.xml fehlt — keine gueltige XLSX-Datei.');
  }

  const relations = parseRelationships(readEntry(files, 'xl/_rels/workbook.xml.rels') ?? '');
  const sharedStrings = parseSharedStrings(readEntry(files, 'xl/sharedStrings.xml'));
  const dateStyles = parseDateStyles(readEntry(files, 'xl/styles.xml'));

  const sheets: XlsxSheet[] = [];
  parseSheetIndex(workbookXml).forEach((entry, index) => {
    const target = entry.relationId ? relations.get(entry.relationId) : undefined;
    // Ohne Relationship greifen wir auf die konventionelle Ablage zurueck.
    const path = target ? resolveSheetPath(target) : `xl/worksheets/sheet${index + 1}.xml`;
    const xml = readEntry(files, path);
    sheets.push({
      name: entry.name,
      rows: xml === null ? [] : parseSheet(xml, sharedStrings, dateStyles),
    });
  });
  return sheets;
}

function readEntry(files: Record<string, Uint8Array>, path: string): string | null {
  const raw = files[path];
  return raw === undefined ? null : strFromU8(raw);
}

/** Rels-Ziele sind relativ zu `xl/` oder absolut ab Paketwurzel. */
function resolveSheetPath(target: string): string {
  const clean = target.replace(/^\.\//, '');
  return clean.startsWith('/') ? clean.slice(1) : `xl/${clean}`;
}

interface SheetIndexEntry {
  name: string;
  relationId: string | null;
}

function parseSheetIndex(xml: string): SheetIndexEntry[] {
  const entries: SheetIndexEntry[] = [];
  let insideSheets = false;
  parseXml(xml, {
    onOpen(name, attrs) {
      if (name === 'sheets') {
        insideSheets = true;
        return;
      }
      if (!insideSheets || name !== 'sheet') return;
      entries.push({
        name: attrs.name ?? `Blatt ${entries.length + 1}`,
        relationId: attrs.id ?? null,
      });
    },
    onClose(name) {
      if (name === 'sheets') insideSheets = false;
    },
  });
  return entries;
}

function parseRelationships(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  parseXml(xml, {
    onOpen(name, attrs) {
      if (name !== 'Relationship' || !attrs.Id || !attrs.Target) return;
      map.set(attrs.Id, attrs.Target);
    },
  });
  return map;
}

/**
 * `<si>` kann aus mehreren `<r><t>`-Laeufen bestehen; phonetische Hinweise
 * (`<rPh>`) gehoeren nicht zum Zellwert.
 */
function parseSharedStrings(xml: string | null): string[] {
  if (xml === null) return [];
  const strings: string[] = [];
  let current: string[] | null = null;
  let phoneticDepth = 0;
  let inText = false;

  parseXml(xml, {
    onOpen(name) {
      if (name === 'si') {
        current = [];
        return;
      }
      if (name === 'rPh') phoneticDepth++;
      else if (name === 't' && phoneticDepth === 0) inText = true;
    },
    onClose(name) {
      if (name === 'si') {
        strings.push((current ?? []).join(''));
        current = null;
      } else if (name === 'rPh') {
        phoneticDepth = Math.max(0, phoneticDepth - 1);
      } else if (name === 't') {
        inText = false;
      }
    },
    onText(text) {
      if (inText && current !== null) current.push(text);
    },
  });
  return strings;
}

/** Eingebaute Zahlenformate, die ein Datum oder eine Uhrzeit darstellen. */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
/** Format-Codes ohne Datumsanteil trotz `y/m/d`-aehnlicher Zeichen. */
const FORMAT_LITERAL = /"[^"]*"|\\.|\[[^\]]*\]/g;
const FORMAT_DATE_TOKEN = /[ymdhs]/i;

/**
 * Liefert die `cellXfs`-Indizes, deren Zahlenformat ein Datum ist. `s` an der
 * Zelle verweist genau auf diese Liste.
 */
function parseDateStyles(xml: string | null): Set<number> {
  if (xml === null) return new Set();

  const customDateFormats = new Set<number>();
  const cellFormatIds: number[] = [];
  let insideCellXfs = false;
  let insideNumFmts = false;

  parseXml(xml, {
    onOpen(name, attrs) {
      if (name === 'numFmts') {
        insideNumFmts = true;
        return;
      }
      // `numFmt` steht auch unter `dxf` (bedingte Formatierung) und in
      // x14-Erweiterungen. Dort adressiert die ID NICHT die globale
      // Formattabelle — ein `numFmtId="0"` mit Datums-Code wuerde sonst
      // "General" vergiften und jede blanke Zahl der Mappe zum Datum machen.
      if (name === 'numFmt') {
        if (!insideNumFmts) return;
        const id = Number.parseInt(attrs.numFmtId ?? '', 10);
        if (Number.isFinite(id) && isDateFormatCode(attrs.formatCode ?? ''))
          customDateFormats.add(id);
        return;
      }
      if (name === 'cellXfs') {
        insideCellXfs = true;
        return;
      }
      // `cellStyleXfs` enthaelt ebenfalls `xf` — die adressiert `s` aber nicht.
      if (insideCellXfs && name === 'xf') {
        cellFormatIds.push(Number.parseInt(attrs.numFmtId ?? '0', 10) || 0);
      }
    },
    onClose(name) {
      if (name === 'cellXfs') insideCellXfs = false;
      else if (name === 'numFmts') insideNumFmts = false;
    },
  });

  const dateStyleIndexes = new Set<number>();
  cellFormatIds.forEach((numFmtId, index) => {
    if (BUILTIN_DATE_FORMATS.has(numFmtId) || customDateFormats.has(numFmtId)) {
      dateStyleIndexes.add(index);
    }
  });
  return dateStyleIndexes;
}

function isDateFormatCode(code: string): boolean {
  const stripped = code.replace(FORMAT_LITERAL, '');
  return FORMAT_DATE_TOKEN.test(stripped);
}

interface PendingCell {
  row: number;
  column: number;
  type: string;
  styleIndex: number;
  value: string;
  inlineText: string[];
}

function parseSheet(xml: string, sharedStrings: string[], dateStyles: Set<number>): XlsxValue[][] {
  const cells = new Map<number, Map<number, XlsxValue>>();
  let maxRow = -1;
  let maxColumn = -1;

  let rowIndex = -1;
  let columnCursor = 0;
  let cell: PendingCell | null = null;
  let inValue = false;
  let inInlineText = false;
  let valueChunks: string[] = [];

  parseXml(xml, {
    onOpen(name, attrs) {
      switch (name) {
        case 'row': {
          const declared = Number.parseInt(attrs.r ?? '', 10);
          rowIndex = Number.isFinite(declared) ? declared - 1 : rowIndex + 1;
          columnCursor = 0;
          break;
        }
        case 'c': {
          const position = parseCellReference(attrs.r);
          const column = position ? position.column : columnCursor;
          const row = position ? position.row : rowIndex;
          columnCursor = column + 1;
          cell = {
            row,
            column,
            type: attrs.t ?? 'n',
            styleIndex: Number.parseInt(attrs.s ?? '', 10),
            value: '',
            inlineText: [],
          };
          break;
        }
        case 'v':
          if (cell) {
            inValue = true;
            valueChunks = [];
          }
          break;
        case 't':
          if (cell && cell.type === 'inlineStr') inInlineText = true;
          break;
        default:
          break;
      }
    },
    onClose(name) {
      switch (name) {
        case 'v':
          if (inValue && cell) cell.value = valueChunks.join('');
          inValue = false;
          break;
        case 't':
          inInlineText = false;
          break;
        case 'c': {
          if (!cell) break;
          const value = materializeCell(cell, sharedStrings, dateStyles);
          if (value !== null && cell.row >= 0 && cell.row < MAX_ROWS && cell.column < MAX_COLUMNS) {
            let rowCells = cells.get(cell.row);
            if (!rowCells) {
              rowCells = new Map();
              cells.set(cell.row, rowCells);
            }
            rowCells.set(cell.column, value);
            if (cell.row > maxRow) maxRow = cell.row;
            if (cell.column > maxColumn) maxColumn = cell.column;
          }
          cell = null;
          break;
        }
        default:
          break;
      }
    },
    onText(text) {
      if (inValue) valueChunks.push(text);
      else if (inInlineText && cell) cell.inlineText.push(text);
    },
  });

  if (maxRow < 0 || maxColumn < 0) return [];

  const width = maxColumn + 1;
  const height = maxRow + 1;
  if (height * width > MAX_CELLS) {
    throw new XlsxReadError(
      `Arbeitsblatt ist mit ${height}x${width} Zellen zu gross fuer die Verarbeitung.`,
    );
  }

  const rows: XlsxValue[][] = [];
  for (let r = 0; r < height; r++) {
    const rowCells = cells.get(r);
    const row: XlsxValue[] = new Array<XlsxValue>(width).fill(null);
    if (rowCells) for (const [column, value] of rowCells) row[column] = value;
    rows.push(row);
  }
  return rows;
}

function materializeCell(
  cell: PendingCell,
  sharedStrings: string[],
  dateStyles: Set<number>,
): XlsxValue {
  switch (cell.type) {
    case 's': {
      const index = Number.parseInt(cell.value, 10);
      if (!Number.isFinite(index)) return null;
      return sharedStrings[index] ?? null;
    }
    case 'inlineStr': {
      const text = cell.inlineText.join('');
      return text === '' ? null : text;
    }
    // `str` ist ein Formel-Ergebnis vom Typ Text, `e` eine Fehlerzelle.
    case 'str':
      return cell.value === '' ? null : cell.value;
    case 'e':
      return null;
    case 'b':
      return cell.value === '1';
    case 'd':
      return parseIsoDate(cell.value);
    default: {
      if (cell.value === '') return null;
      const numeric = Number(cell.value);
      if (!Number.isFinite(numeric)) return cell.value;
      return dateStyles.has(cell.styleIndex) ? serialToDate(numeric) : numeric;
    }
  }
}

function parseIsoDate(value: string): Date | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time) : null;
}

/**
 * Serielles Excel-Datum -> UTC-Date. Bezug ist 1899-12-30, weil Excel 1900
 * faelschlich als Schaltjahr fuehrt; ab Serie 61 (01.03.1900) gleichen sich
 * beide Fehler aus. Darunter korrigieren wir um einen Tag, damit auch alte
 * Belegdaten dieselbe Anzeige wie in Excel ergeben. Serie 60 ist Excels
 * Phantom-29.02.1900 und faellt bewusst auf den 28.02.1900.
 */
export function serialToDate(serial: number): Date {
  const EPOCH_UTC_MS = Date.UTC(1899, 11, 30);
  const MS_PER_DAY = 86_400_000;
  const corrected = serial < 60 ? serial + 1 : serial;
  // Auf ganze Millisekunden runden: 0.1-Tage-Anteile sind binaer nicht exakt.
  return new Date(EPOCH_UTC_MS + Math.round(corrected * MS_PER_DAY));
}

const CELL_REFERENCE = /^([A-Z]+)(\d+)$/;

/** `D12` -> `{ row: 11, column: 3 }`. */
export function parseCellReference(
  ref: string | undefined,
): { row: number; column: number } | null {
  if (!ref) return null;
  const match = CELL_REFERENCE.exec(ref.toUpperCase());
  if (!match) return null;
  let column = 0;
  for (const char of match[1]!) column = column * 26 + (char.charCodeAt(0) - 64);
  const row = Number.parseInt(match[2]!, 10);
  if (!Number.isFinite(row) || row < 1) return null;
  return { row: row - 1, column: column - 1 };
}
