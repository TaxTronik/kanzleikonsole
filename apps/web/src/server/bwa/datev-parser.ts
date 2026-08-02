// =============================================================================
// Parser für DATEV-BWA-XLSX
// (Dateiname-Format: <Beraternr>_<Mandantennr>_<Jahr>_Vorjahresvergleich.xlsx)
//
// Aufbau:
//   Zeile 1: Kanzlei-Header
//   Zeile 2: Spalten — Zeile, Konto, Bezeichnung,
//            <MMM/YYYY>, <MMM/YYYY-1>, Veränderung, in %,
//            <Mon-Range YYYY>, <Mon-Range YYYY-1>, Veränderung, in %
//   Zeile 3+: Daten-Zeilen
//     - Wenn `Zeile` (Spalte A) gesetzt → Hauptposition (Summe)
//     - Wenn `Konto` (Spalte B) gesetzt → Sub-Konto-Detail (überspringen)
//     - Komplett leere Zeilen → Trenner
//
// Wir importieren NUR Hauptpositionen (Spalte A gesetzt) — sie repräsentieren
// die offizielle DATEV-BWA-Gliederung (Zeilen 1020, 1051, 1080, 1100, 1380 …).
// =============================================================================

import { readXlsx, type XlsxValue } from '@/lib/xlsx/read-xlsx';
import type { ParsedBwa, ParsedBwaPeriod, ParsedBwaPosition } from './addison-parser';

const MONTH_DE: Record<string, number> = {
  jan: 1,
  feb: 2,
  mär: 3,
  mar: 3,
  // Deutsches Excel schreibt den Maerz je nach Version als „Mär" oder „Mrz".
  mrz: 3,
  apr: 4,
  mai: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  okt: 10,
  nov: 11,
  dez: 12,
};

interface DatevColumnSpec {
  index: number;
  type: 'YEAR' | 'MONTH';
  periodKey: string;
  fromDate: Date;
  toDate: Date;
  label: string;
}

/**
 * Parst Header-Zellen wie "Dez/2025" (MONTH) oder "Jan/2025 - Dez/2025" (YEAR).
 */
function parseDatevColumnHeader(raw: string): Omit<DatevColumnSpec, 'index'> | null {
  const s = raw.replace(/\s+/g, ' ').trim();

  // Year-Range: "Jan/2025 - Dez/2025" oder mit Newlines
  const yearMatch = s.match(/^([A-Za-zÄäÖöÜüß]+)\/(\d{4})\s*-\s*([A-Za-zÄäÖöÜüß]+)\/(\d{4})$/);
  if (yearMatch) {
    const fm = MONTH_DE[yearMatch[1]!.toLowerCase().slice(0, 3)];
    const fy = Number(yearMatch[2]);
    const tm = MONTH_DE[yearMatch[3]!.toLowerCase().slice(0, 3)];
    const ty = Number(yearMatch[4]);
    if (!fm || !tm) return null;
    const fromDate = new Date(Date.UTC(fy, fm - 1, 1));
    const toDate = new Date(Date.UTC(ty, tm, 0));
    if (fm === 1 && tm === 12 && fy === ty) {
      return { type: 'YEAR', periodKey: String(fy), fromDate, toDate, label: `Jahr ${fy}` };
    }
    return {
      type: 'YEAR',
      periodKey: `${fy}-${String(fm).padStart(2, '0')}-${ty}-${String(tm).padStart(2, '0')}`,
      fromDate,
      toDate,
      label: `${fm}/${fy} – ${tm}/${ty}`,
    };
  }

  // Single month: "Dez/2025"
  const monthMatch = s.match(/^([A-Za-zÄäÖöÜüß]+)\/(\d{4})$/);
  if (monthMatch) {
    const m = MONTH_DE[monthMatch[1]!.toLowerCase().slice(0, 3)];
    const y = Number(monthMatch[2]);
    if (!m) return null;
    const fromDate = new Date(Date.UTC(y, m - 1, 1));
    const toDate = new Date(Date.UTC(y, m, 0));
    return {
      type: 'MONTH',
      periodKey: `${y}-${String(m).padStart(2, '0')}`,
      fromDate,
      toDate,
      label: `${String(m).padStart(2, '0')}/${y}`,
    };
  }

  return null;
}

function cellNumber(value: XlsxValue): number | null {
  if (value === null || value === '') return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const cleaned = value.trim().replace(/\./g, '').replace(',', '.');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function cellAt(rows: XlsxValue[][], row: number, column: number): XlsxValue {
  return rows[row]?.[column] ?? null;
}

function cellString(value: XlsxValue): string {
  if (value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

export async function parseDatevBwaXlsx(buffer: Buffer | Uint8Array): Promise<ParsedBwa> {
  const sheets = readXlsx(buffer);
  const warnings: string[] = [];

  // Erstes Sheet (DATEV exportiert "BWA" als einziges Sheet)
  const rows = sheets[0]?.rows;
  if (!rows) return { periods: [], warnings: ['Keine Arbeitsblätter im XLSX gefunden.'] };

  // Header-Zeile finden — wir suchen die erste Zeile, die in Spalte A "Zeile" enthält
  let headerRowIdx = -1;
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    if (cellString(cellAt(rows, r, 0)).toLowerCase() === 'zeile') {
      headerRowIdx = r;
      break;
    }
  }
  if (headerRowIdx === -1) {
    return { periods: [], warnings: ['Header-Zeile (Spalte A = "Zeile") nicht gefunden.'] };
  }

  // Periodenspalten in Header identifizieren
  const headerRow = rows[headerRowIdx]!;
  const colSpecs: DatevColumnSpec[] = [];
  for (let c = 3; c < headerRow.length; c++) {
    const meta = parseDatevColumnHeader(cellString(headerRow[c] ?? null));
    if (meta) colSpecs.push({ index: c, ...meta });
  }
  if (colSpecs.length === 0) {
    return { periods: [], warnings: ['Keine Datums-Spalten im Header erkannt.'] };
  }

  // Periodenobjekte initialisieren
  const periods: ParsedBwaPeriod[] = colSpecs.map((s) => ({
    type: s.type,
    periodKey: s.periodKey,
    fromDate: s.fromDate,
    toDate: s.toDate,
    label: s.label,
    positions: [],
  }));

  // Datenzeilen ab headerRowIdx + 1
  for (let r = headerRowIdx + 1; r < rows.length; r++) {
    const row = rows[r]!;
    const zeileStr = cellString(row[0] ?? null);
    if (!zeileStr || !/^\d+$/.test(zeileStr)) continue; // nur Hauptpositionen
    const number = Number(zeileStr);
    const label = cellString(row[2] ?? null);
    if (!label) continue;

    colSpecs.forEach((spec, pi) => {
      const amount = cellNumber(row[spec.index] ?? null);
      if (amount === null) return;
      const p: ParsedBwaPosition = { number, label, amount, sharePct: null };
      periods[pi]!.positions.push(p);
    });
  }

  const filtered = periods.filter((p) => p.positions.length > 0);
  if (filtered.length === 0) {
    warnings.push('Datenzeilen erkannt, aber keine Werte konvertierbar.');
  }
  return { periods: filtered, warnings };
}
