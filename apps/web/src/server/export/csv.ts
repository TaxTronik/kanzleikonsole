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

// Zeichen, mit denen Excel/LibreOffice eine Zelle als Formel interpretieren
// (CSV-Injection). Wenn ein Wert mit einem dieser Zeichen beginnt, prefixen
// wir mit einem Apostroph — das wird beim Öffnen ausgeblendet, neutralisiert
// aber die Formel-Erkennung.
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function escapeCsvCell(v: string | number | null | undefined | Date | bigint): string {
  if (v === null || v === undefined) return '';
  let s: string;
  if (v instanceof Date) {
    s = new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'medium' }).format(v);
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

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const lines: string[] = [];
  lines.push(columns.map((c) => escapeCsvCell(c.label)).join(';'));
  for (const row of rows) {
    lines.push(columns.map((c) => escapeCsvCell(c.accessor(row))).join(';'));
  }
  // CRLF + UTF-8-BOM für Excel
  return '﻿' + lines.join('\r\n');
}

export function csvResponse(filename: string, csv: string): Response {
  const safe = filename.replace(/[^A-Za-z0-9_-]/g, '_');
  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${safe}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
