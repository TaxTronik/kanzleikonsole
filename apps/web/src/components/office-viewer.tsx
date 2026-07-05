'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { fmtDateTimeShort } from '@/lib/fmt';

/**
 * Inline-Viewer für Word- und Excel-Dateien direkt im Browser, ohne
 * Drittanbieter (kein MS Office Online, kein Google Viewer). Daten bleiben
 * im Mandanten-Netz — wichtig für GoBD-/§-203-StGB-relevante Dokumente.
 *
 *  - DOCX:  rendert via `docx-preview` zu HTML.
 *  - XLSX:  parst mit `exceljs` und zeigt das erste Arbeitsblatt als HTML-Tabelle.
 *
 * Beide Libraries werden dynamisch geladen (kein Bundle-Bloat im Hauptpfad).
 */
export function OfficeViewer({
  url,
  kind,
}: {
  url: string;
  kind: 'docx' | 'xlsx';
}) {
  // Callback-Ref als State: Der Effekt läuft erst, wenn der Container im DOM
  // ist (kein Busy-Wait/Polling nötig).
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sheets, setSheets] = useState<XlsxSheet[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);

  useEffect(() => {
    // DOCX braucht den DOM-Container — erst rendern, wenn er gemountet ist.
    if (kind === 'docx' && !container) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Datei laden: HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        if (cancelled) return;

        if (kind === 'docx') {
          if (!container) return;
          const mod = await import('docx-preview');
          container.innerHTML = '';
          await mod.renderAsync(buf, container, undefined, {
            className: 'docx-rendered',
            inWrapper: true,
            ignoreWidth: false,
            ignoreHeight: false,
            useBase64URL: true,
          });
        } else {
          const ExcelJS = (await import('exceljs')).default;
          const wb = new ExcelJS.Workbook();
          await wb.xlsx.load(buf);
          const result: XlsxSheet[] = [];
          wb.eachSheet((ws) => {
            const rows: string[][] = [];
            ws.eachRow({ includeEmpty: true }, (row) => {
              const cells: string[] = [];
              row.eachCell({ includeEmpty: true }, (cell) => {
                cells.push(formatCell(cell.value));
              });
              rows.push(cells);
            });
            result.push({ name: ws.name, rows });
          });
          if (cancelled) return;
          setSheets(result);
          setActiveSheet(0);
        }
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
  }, [url, kind, container]);

  // DOCX: Container ist IMMER gerendert, Spinner ist Overlay
  if (kind === 'docx') {
    return (
      <div className="relative h-full bg-white">
        <div className="h-full overflow-y-auto p-6">
          <div ref={setContainer} className="docx-viewer" />
        </div>
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/80 backdrop-blur-sm">
            <Loader2 className="h-6 w-6 text-disabled animate-spin" />
            <span className="ml-2 text-sm text-secondary">Lade Word-Vorschau…</span>
          </div>
        )}
        {error && !loading && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-red-700 px-6 text-center bg-white">
            Vorschau konnte nicht geladen werden: {error}
          </div>
        )}
      </div>
    );
  }

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

interface XlsxSheet { name: string; rows: string[][]; }

function XlsxTable({ rows }: { rows: string[][] }) {
  if (rows.length === 0) return <p className="text-sm text-disabled">Leere Tabelle.</p>;
  const [head, ...body] = rows;
  return (
    <table className="text-xs border-collapse">
      <thead className="bg-gray-100 sticky top-0">
        <tr>
          {head!.map((c, i) => (
            <th key={i} className="border border-default px-2 py-1 text-left font-medium text-secondary whitespace-nowrap">
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

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value.toLocaleString('de-DE');
  if (typeof value === 'boolean') return value ? 'Ja' : 'Nein';
  if (value instanceof Date) return fmtDateTimeShort(value);
  if (typeof value === 'object') {
    const o = value as { text?: unknown; richText?: { text?: unknown }[]; result?: unknown; formula?: unknown; hyperlink?: unknown };
    if (typeof o.text === 'string') return o.text;
    if (Array.isArray(o.richText)) {
      return o.richText.map((p) => (typeof p.text === 'string' ? p.text : '')).join('');
    }
    if (o.result !== undefined) return formatCell(o.result);
    if (typeof o.hyperlink === 'string') return o.hyperlink;
    if (typeof o.formula === 'string') return `=${o.formula}`;
  }
  return String(value);
}
