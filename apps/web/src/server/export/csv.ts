import { fmtDateTimeSeconds } from '@/lib/fmt';
// =============================================================================
// CSV-Export-Helper (RFC 4180, deutsche Locale: Komma-Dezimal + Semikolon-Sep)
//
// Excel öffnet UTF-8-CSV korrekt nur mit BOM. Wir schreiben deshalb ein BOM
// und nutzen Semikolon als Separator (deutsche Excel-Convention).
// =============================================================================

export interface CsvColumn<T> {
  key: string;
  label: string;
  accessor: (row: T) => string | number | null | undefined | Date | bigint;
}

// Einheitliche Export-Obergrenze (vorher 4× pro Route dupliziert). Deckelt
// Speicher + synchronen CSV-Aufbau (Event-Loop-Block) auf monoton wachsenden
// Tabellen. Die Routen lesen MAX_EXPORT_ROWS + 1 und übergeben das Ergebnis an
// applyRowCap — so wird Trunkierung ohne Extra-count() erkannt.
export const MAX_EXPORT_ROWS = 10_000;

/**
 * Trunkierungs-Erkennung: die Route liest `maxRows + 1` Zeilen. Sind mehr als
 * `maxRows` zurückgekommen, existieren weitere → auf `maxRows` trimmen und
 * `truncated` melden.
 */
export function applyRowCap<T>(
  rows: T[],
  maxRows: number = MAX_EXPORT_ROWS,
): { rows: T[]; truncated: boolean } {
  const truncated = rows.length > maxRows;
  return { rows: truncated ? rows.slice(0, maxRows) : rows, truncated };
}

// Zeichen, mit denen Excel/LibreOffice eine Zelle als Formel interpretieren
// (CSV-Injection). Wenn ein Wert mit einem dieser Zeichen beginnt, prefixen
// wir mit einem Apostroph — das wird beim Öffnen ausgeblendet, neutralisiert
// aber die Formel-Erkennung.
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function escapeCsvCell(v: string | number | null | undefined | Date | bigint): string {
  if (v === null || v === undefined) return '';
  let s: string;
  if (v instanceof Date) {
    s = fmtDateTimeSeconds(v);
  } else if (typeof v === 'bigint') {
    s = String(v);
  } else if (typeof v === 'number') {
    // Deutsche Lokal-Konvention: Komma als Dezimal, kein Tausenderpunkt.
    // Numerische Werte sind nie Formel-anfällig (kein führendes =/+/@) — also
    // hier raus ohne Prefix-Check.
    s = String(v).replace('.', ',');
    return s;
  } else {
    s = String(v);
  }
  if (FORMULA_PREFIX.test(s)) {
    s = `'${s}`;
  }
  // Escapen wenn Sonderzeichen
  if (s.includes('"') || s.includes(';') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsv<T>(
  rows: T[],
  columns: CsvColumn<T>[],
  opts?: { truncatedNote?: string },
): string {
  const lines: string[] = [];
  lines.push(columns.map((c) => escapeCsvCell(c.label)).join(';'));
  for (const row of rows) {
    lines.push(columns.map((c) => escapeCsvCell(c.accessor(row))).join(';'));
  }
  // Trunkierungs-Hinweis SICHTBAR in der Datei (kritisch für Audit-/Prüfer-
  // Exporte: ein vollständig aussehender, aber stillschweigend gekürzter Export
  // ist gefährlicher als ein erkennbar unvollständiger). Leerzeile + Einzel-
  // zellen-Hinweiszeile am Ende — bleibt valides CSV (ein Feld, keine Trenner).
  if (opts?.truncatedNote) {
    lines.push('');
    lines.push(escapeCsvCell(opts.truncatedNote));
  }
  // CRLF + UTF-8-BOM für Excel
  return '﻿' + lines.join('\r\n');
}

/** Einheitlicher, sichtbarer Trunkierungs-Hinweis für gekürzte Exporte. */
export function truncationNote(maxRows: number): string {
  return `EXPORT UNVOLLSTÄNDIG: auf ${maxRows.toLocaleString('de-DE')} Zeilen begrenzt — es existieren weitere Zeilen. Bitte den Abruf weiter eingrenzen (z. B. Zeitraum/Status).`;
}

export function csvResponse(
  filename: string,
  csv: string,
  opts?: { truncated?: boolean },
): Response {
  const safe = filename.replace(/[^A-Za-z0-9_-]/g, '_');
  const headers: Record<string, string> = {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${safe}.csv"`,
    'Cache-Control': 'no-store',
  };
  // Maschinen-/UI-Signal zusätzlich zum sichtbaren In-Datei-Hinweis.
  if (opts?.truncated) headers['X-Export-Truncated'] = 'true';
  return new Response(csv, { status: 200, headers });
}
