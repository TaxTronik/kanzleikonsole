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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sheets, setSheets] = useState<XlsxSheet[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

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
    <div className="h-full flex flex-col bg-white">
      {sheets.length > 1 && (
        <div className="flex gap-0 border-b border-default bg-gray-50 px-2 overflow-x-auto">
          {sheets.map((s, i) => (
            <button
              key={s.name + i}
              type="button"
              onClick={() => setActiveSheet(i)}
              className={
                i === activeSheet
                  ? 'px-3 py-1.5 text-xs font-medium border-b-2 border-brand-600 text-brand-700 -mb-px'
                  : 'px-3 py-1.5 text-xs text-secondary hover:text-primary border-b-2 border-transparent -mb-px'
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

interface XlsxSheet {
  name: string;
  rows: string[][];
}

function XlsxTable({ rows }: { rows: string[][] }) {
  if (rows.length === 0) return <p className="text-sm text-disabled">Leere Tabelle.</p>;
  const [head, ...body] = rows;
  return (
    <table className="text-xs border-collapse">
      <thead className="bg-gray-100 sticky top-0">
        <tr>
          {head!.map((c, i) => (
            <th
              key={i}
              className="border border-default px-2 py-1 text-left font-medium text-secondary whitespace-nowrap"
            >
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {body.map((row, ri) => (
          <tr key={ri} className="hover:bg-gray-50">
            {row.map((c, ci) => (
              <td
                key={ci}
                className="border border-subtle px-2 py-1 text-primary whitespace-nowrap max-w-[24rem] overflow-hidden text-ellipsis"
                title={c}
              >
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
