'use client';

// =============================================================================
// Export-Auswahl: welche Markierungen in DOCX/PDF übernommen werden. Standard =
// alle. Die laufende Nr. (Position) entspricht der im Export; nicht gewählte
// Stellen erscheinen im Sachverhalt als normaler Text. Die Download-Links hängen
// die Auswahl als `?marks=` an (entfällt, wenn alle gewählt sind → ganzer Bericht).
// =============================================================================

import { useMemo, useState } from 'react';
import { FileDown, FileText, FileType, ChevronDown } from 'lucide-react';
import { type MarkingDTO, herkunftColor } from './_ui';

export function ExportPanel({
  clientId,
  analysisId,
  markings,
}: {
  clientId: string;
  analysisId: string;
  markings: MarkingDTO[];
}) {
  const ordered = useMemo(
    () => [...markings].sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id)),
    [markings],
  );
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<Set<string>>(() => new Set(ordered.map((m) => m.id)));

  const allIds = ordered.map((m) => m.id);
  const allSelected = sel.size === allIds.length && allIds.every((id) => sel.has(id));
  const none = sel.size === 0;

  function toggle(id: string) {
    setSel((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  const marksParam = allSelected ? '' : `&marks=${[...sel].join(',')}`;
  const href = (fmt: 'docx' | 'pdf') =>
    `/api/staff/clients/${clientId}/subsumtion/${analysisId}/export?format=${fmt}${marksParam}`;

  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} className="btn-secondary text-xs" title="Exportieren (Auswahl der Markierungen)">
        <FileDown className="h-3.5 w-3.5" /> Export <ChevronDown className="h-3 w-3" />
      </button>

      {open && (
        <>
          {/* Klick außerhalb schließt das Panel. */}
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-30 mt-1 w-96 max-w-[92vw] card p-3 shadow-lg space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium text-primary">Markierungen für den Export</p>
              <div className="text-xs flex items-center gap-2">
                <button type="button" className="hover:underline" onClick={() => setSel(new Set(allIds))}>Alle</button>
                <span className="text-disabled">·</span>
                <button type="button" className="hover:underline" onClick={() => setSel(new Set())}>Keine</button>
              </div>
            </div>

            {ordered.length === 0 ? (
              <p className="text-xs text-muted">Keine Markierungen vorhanden — der reine Sachverhalt wird exportiert.</p>
            ) : (
              <div className="max-h-64 overflow-y-auto rounded border border-default divide-y divide-default">
                {ordered.map((m, i) => (
                  <label key={m.id} className="flex items-start gap-2 px-2 py-1.5 text-xs cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-900/40">
                    <input type="checkbox" checked={sel.has(m.id)} onChange={() => toggle(m.id)} className="mt-0.5" />
                    <span className="font-mono text-[10px] mt-0.5" style={{ color: m.streitig ? '#ef4444' : herkunftColor(m.herkunft) }}>[{i + 1}]</span>
                    <span className="min-w-0">
                      <span className="font-medium text-secondary">{m.begriff}</span>
                      {m.matchedText ? <span className="text-muted"> — „{m.matchedText.length > 60 ? m.matchedText.slice(0, 60) + '…' : m.matchedText}"</span> : null}
                    </span>
                  </label>
                ))}
              </div>
            )}

            <div className="flex items-center gap-2 pt-1">
              <span className="text-xs text-muted">{none ? 'mind. eine wählen' : `${allSelected ? 'alle' : sel.size} ausgewählt`}</span>
              {none ? (
                <>
                  <span className="ml-auto btn-secondary text-xs opacity-40 pointer-events-none"><FileText className="h-3.5 w-3.5" /> DOCX</span>
                  <span className="btn-secondary text-xs opacity-40 pointer-events-none"><FileType className="h-3.5 w-3.5" /> PDF</span>
                </>
              ) : (
                <>
                  <a href={href('docx')} className="ml-auto btn-secondary text-xs" onClick={() => setOpen(false)}><FileText className="h-3.5 w-3.5" /> DOCX</a>
                  <a href={href('pdf')} className="btn-secondary text-xs" onClick={() => setOpen(false)}><FileType className="h-3.5 w-3.5" /> PDF</a>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
