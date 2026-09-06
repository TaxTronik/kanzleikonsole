'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { formatXlsxCell } from '@/lib/xlsx/format-cell';

/**
 * Inline-Viewer für Excel-Dateien direkt im Browser, ohne
 * Drittanbieter (kein MS Office Online, kein Google Viewer). Daten bleiben
 * im Mandanten-Netz — wichtig für GoBD-/§-203-StGB-relevante Dokumente.
 *
 *  - XLSX:  parst mit dem eigenen Reader und zeigt das Arbeitsblatt als
 *           HTML-Tabelle.
 *
 * Der Reader wird dynamisch geladen (kein Bundle-Bloat im Hauptpfad).
 */
export function OfficeViewer({ url }: { url: string }) {
  return <OfficeDocument key={url} url={url} />;
}

function OfficeDocument({ url }: { url: string }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sheets, setSheets] = useState<XlsxSheet[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Datei laden: HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        if (cancelled) return;

        const { readXlsx } = await import('@/lib/xlsx/read-xlsx');
        const result: XlsxSheet[] = readXlsx(buf).map((ws) => ({
          name: ws.name,
          rows: ws.rows.map((row) => row.map(formatXlsxCell)),
        }));
        if (cancelled) return;
        setSheets(result);
        setActiveSheet(0);
      } catch (e) {
        console.error('[OfficeViewer]', e);
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [url]);

  // XLSX: erst Loader, dann Sheets
  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-muted">
        <Loader2 className="h-6 w-6 animate-spin" />
        <span className="ml-2 text-sm">Lade Excel-Vorschau…</span>
      </div>
    );
  }
  if (error) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-red-700 px-6 text-center">
        Vorschau konnte nicht geladen werden: {error}
      </div>
    );
  }

  const sheet = sheets[activeSheet];
  return (
    <div className={`h-full flex flex-col ${SHEET_CANVAS} ${SHEET_TEXT}`}>
      {sheets.length > 1 && (
        <div className={`flex gap-0 border-b ${SHEET_BORDER} ${SHEET_BAR} px-2 overflow-x-auto`}>
          {sheets.map((s, i) => (
            <button
              key={s.name + i}
              type="button"
              onClick={() => setActiveSheet(i)}
              className={
                i === activeSheet
                  ? 'px-3 py-1.5 text-xs font-medium border-b-2 border-brand-600 text-brand-700 -mb-px'
                  : `px-3 py-1.5 text-xs ${SHEET_TEXT_MUTED} hover:text-[#111827] border-b-2 border-transparent -mb-px`
              }
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="flex-1 overflow-auto p-2">
        {sheet ? <XlsxTable rows={sheet.rows} /> : null}
      </div>
    </div>
  );
}

// Die Vorschau ist Dokumentinhalt, kein Bestandteil der Oberflaeche — wie eine
// PDF-Seite bleibt sie in beiden Themes ein heller Bogen. Die Farben stehen
// deshalb als feste Werte da und NICHT als `text-primary`/`bg-gray-100`: Das
// Theme bildet `gray-50`…`gray-700` und die Text-Tokens auf Dark-Werte ab, der
// Container war aber fest weiss. Im Darkmode ergab das hellgrauen Text auf
// weissem Grund — praktisch unlesbar. Werte entsprechen der Light-Palette.
const SHEET_CANVAS = 'bg-[#ffffff]';
const SHEET_BAR = 'bg-[#f9fafb]';
const SHEET_HEADER = 'bg-[#f3f4f6]';
const SHEET_BORDER = 'border-[#e5e7eb]';
const SHEET_BORDER_SUBTLE = 'border-[#f3f4f6]';
const SHEET_TEXT = 'text-[#111827]';
const SHEET_TEXT_MUTED = 'text-[#4b5563]';
const SHEET_ROW_HOVER = 'hover:bg-[#f9fafb]';

interface XlsxSheet {
  name: string;
  rows: string[][];
}

// Anzeigegrenzen. Der Reader laesst bis zu 4 Mio. Zellen durch — die alle als
// <td> samt title-Attribut zu materialisieren, legt den Browser-Tab lahm. Eine
// Vorschau muss nicht vollstaendig sein; wer die ganze Mappe braucht, laedt sie
// herunter und oeffnet sie in Excel.
const PREVIEW_MAX_ROWS = 500;
const PREVIEW_MAX_COLUMNS = 100;

function XlsxTable({ rows }: { rows: string[][] }) {
  if (rows.length === 0) return <p className="text-sm text-[#6b7280]">Leere Tabelle.</p>;
  const [head, ...body] = rows;
  const columnCount = Math.min(head!.length, PREVIEW_MAX_COLUMNS);
  const shownBody = body.slice(0, PREVIEW_MAX_ROWS);
  const hiddenRows = body.length - shownBody.length;
  const hiddenColumns = head!.length - columnCount;

  return (
    <>
      {(hiddenRows > 0 || hiddenColumns > 0) && (
        <p className={`mb-2 text-xs ${SHEET_TEXT_MUTED}`}>
          Vorschau gekürzt: zeigt {shownBody.length} von {body.length} Zeilen
          {hiddenColumns > 0 ? ` und ${columnCount} von ${head!.length} Spalten` : ''}. Die
          vollständige Mappe steht über den Download bereit.
        </p>
      )}
      <table className="text-xs border-collapse">
        <thead className={`${SHEET_HEADER} sticky top-0`}>
          <tr>
            {head!.slice(0, columnCount).map((c, i) => (
              <th
                key={i}
                className={`border ${SHEET_BORDER} px-2 py-1 text-left font-medium ${SHEET_TEXT_MUTED} whitespace-nowrap`}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shownBody.map((row, ri) => (
            <tr key={ri} className={SHEET_ROW_HOVER}>
              {row.slice(0, columnCount).map((c, ci) => (
                <td
                  key={ci}
                  className={`border ${SHEET_BORDER_SUBTLE} px-2 py-1 ${SHEET_TEXT} whitespace-nowrap max-w-[24rem] overflow-hidden text-ellipsis`}
                  title={c}
                >
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
