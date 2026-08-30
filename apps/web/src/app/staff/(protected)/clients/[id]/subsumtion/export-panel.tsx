'use client';

// =============================================================================
// Export-Auswahl: welche Markierungen in DOCX/PDF übernommen werden. Standard =
// alle. Gruppen-Schalter (je Herkunft) nehmen ganze Gruppen rein/raus (z. B.
// „alle heuristischen Treffer raus"); die Einzelliste darunter erlaubt das
// Feintuning. Die laufende Nr. entspricht der im Export; nicht gewählte Stellen
// erscheinen im Sachverhalt als normaler Text. Die Download-Links hängen die
// Auswahl als `?marks=` an (entfällt, wenn alle gewählt sind → ganzer Bericht).
// =============================================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import { FileDown, FileText, FileType, ChevronDown } from 'lucide-react';
import { type MarkingDTO, type Herkunft, HERKUNFT_LABEL, herkunftColor } from './_ui';

const HERKUNFT_ORDER: Herkunft[] = [
  'WOERTLICH',
  'MUSTER',
  'TRIGGER',
  'LLM',
  'EMBEDDING',
  'BERATER',
];

/** Checkbox mit Misch-Zustand (teilweise gewählt = indeterminate). */
function TriCheckbox({
  checked,
  indeterminate,
  onChange,
}: {
  checked: boolean;
  indeterminate: boolean;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return <input ref={ref} type="checkbox" checked={checked} onChange={onChange} />;
}

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
    () =>
      [...markings].sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id)),
    [markings],
  );
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<Set<string>>(() => new Set(ordered.map((m) => m.id)));
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      requestAnimationFrame(() => triggerRef.current?.focus());
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [open]);

  // Die Markierungsmenge ändert sich zur Laufzeit (z. B. „Neu analysieren" hängt
  // welche an) — der useState-Initializer läuft aber nur einmal. Ohne Abgleich
  // bliebe `sel` veraltet und neue Markierungen wären stillschweigend abgewählt,
  // also im Export verschwiegen. Darum synchronisieren: NEUE Markierungen
  // standardmäßig auswählen (Default = ganzer Bericht), die bisherige Wahl bei
  // bekannten erhalten, entfernte rauswerfen.
  const prevIds = useRef<Set<string>>(new Set(ordered.map((m) => m.id)));
  useEffect(() => {
    setSel((prev) => {
      const next = new Set<string>();
      for (const m of ordered) {
        if (!prevIds.current.has(m.id) || prev.has(m.id)) next.add(m.id);
      }
      return next;
    });
    prevIds.current = new Set(ordered.map((m) => m.id));
  }, [ordered]);

  // Herkunfts-Gruppen (nur vorhandene), in stabiler Reihenfolge.
  const groups = useMemo(() => {
    const byH = new Map<Herkunft, string[]>();
    for (const m of ordered) {
      const arr = byH.get(m.herkunft) ?? [];
      arr.push(m.id);
      byH.set(m.herkunft, arr);
    }
    return HERKUNFT_ORDER.filter((h) => byH.has(h)).map((h) => ({ herkunft: h, ids: byH.get(h)! }));
  }, [ordered]);

  const allIds = ordered.map((m) => m.id);
  const allSelected = sel.size === allIds.length && allIds.every((id) => sel.has(id));
  const none = sel.size === 0;

  function toggle(id: string) {
    setSel((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  function toggleGroup(ids: string[]) {
    setSel((prev) => {
      const n = new Set(prev);
      if (ids.every((id) => n.has(id))) ids.forEach((id) => n.delete(id));
      else ids.forEach((id) => n.add(id));
      return n;
    });
  }

  const marksParam = allSelected ? '' : `&marks=${[...sel].join(',')}`;
  const href = (fmt: 'docx' | 'pdf') =>
    `/api/staff/clients/${clientId}/subsumtion/${analysisId}/export?format=${fmt}${marksParam}`;

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="btn-secondary text-xs"
        title="Exportieren (Auswahl der Markierungen)"
        aria-expanded={open}
        aria-controls="subsumtion-export-options"
      >
        <FileDown className="h-3.5 w-3.5" /> Export <ChevronDown className="h-3 w-3" />
      </button>

      {open && (
        <>
          {/* Klick außerhalb schließt das Panel. */}
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            className="fixed inset-0 z-20 cursor-default"
            onClick={() => {
              setOpen(false);
              requestAnimationFrame(() => triggerRef.current?.focus());
            }}
          />
          <div
            id="subsumtion-export-options"
            role="region"
            aria-label="Exportoptionen"
            className="absolute right-0 z-30 mt-1 w-96 max-w-[92vw] card p-3 shadow-lg space-y-2"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium text-primary">Markierungen für den Export</p>
              <div className="text-xs flex items-center gap-2">
                <button
                  type="button"
                  className="hover:underline"
                  onClick={() => setSel(new Set(allIds))}
                >
                  Alle
                </button>
                <span className="text-disabled">·</span>
                <button type="button" className="hover:underline" onClick={() => setSel(new Set())}>
                  Keine
                </button>
              </div>
            </div>

            {groups.length > 1 && (
              <div className="rounded border border-default px-2 py-1.5">
                <p className="text-[10px] uppercase tracking-wide text-muted mb-1">
                  Gruppen (Herkunft)
                </p>
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  {groups.map((g) => {
                    const cnt = g.ids.filter((id) => sel.has(id)).length;
                    return (
                      <label
                        key={g.herkunft}
                        className="inline-flex items-center gap-1 text-xs cursor-pointer"
                      >
                        <TriCheckbox
                          checked={cnt === g.ids.length}
                          indeterminate={cnt > 0 && cnt < g.ids.length}
                          onChange={() => toggleGroup(g.ids)}
                        />
                        <span style={{ color: herkunftColor(g.herkunft) }}>
                          {HERKUNFT_LABEL[g.herkunft]}
                        </span>
                        <span className="text-disabled">
                          {cnt}/{g.ids.length}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            {ordered.length === 0 ? (
              <p className="text-xs text-muted">
                Keine Markierungen vorhanden — der reine Sachverhalt wird exportiert.
              </p>
            ) : (
              <div className="max-h-64 overflow-y-auto rounded border border-default divide-y divide-default">
                {ordered.map((m, i) => (
                  <label
                    key={m.id}
                    className="flex items-start gap-2 px-2 py-1.5 text-xs cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-900/40"
                  >
                    <input
                      type="checkbox"
                      checked={sel.has(m.id)}
                      onChange={() => toggle(m.id)}
                      className="mt-0.5"
                    />
                    <span
                      className="font-mono text-[10px] mt-0.5"
                      style={{ color: m.streitig ? '#ef4444' : herkunftColor(m.herkunft) }}
                    >
                      [{i + 1}]
                    </span>
                    <span className="min-w-0">
                      <span className="font-medium text-secondary">{m.begriff}</span>
                      <span className="text-disabled"> · {HERKUNFT_LABEL[m.herkunft]}</span>
                      {m.matchedText ? (
                        <span className="text-muted">
                          {' '}
                          — „
                          {m.matchedText.length > 52
                            ? m.matchedText.slice(0, 52) + '…'
                            : m.matchedText}
                          "
                        </span>
                      ) : null}
                    </span>
                  </label>
                ))}
              </div>
            )}

            <div className="flex items-center gap-2 pt-1">
              <span className="text-xs text-muted">
                {none ? 'mind. eine wählen' : `${allSelected ? 'alle' : sel.size} ausgewählt`}
              </span>
              {none ? (
                <>
                  <span className="ml-auto btn-secondary text-xs opacity-40 pointer-events-none">
                    <FileText className="h-3.5 w-3.5" /> DOCX
                  </span>
                  <span className="btn-secondary text-xs opacity-40 pointer-events-none">
                    <FileType className="h-3.5 w-3.5" /> PDF
                  </span>
                </>
              ) : (
                <>
                  <a
                    href={href('docx')}
                    className="ml-auto btn-secondary text-xs"
                    onClick={() => setOpen(false)}
                  >
                    <FileText className="h-3.5 w-3.5" /> DOCX
                  </a>
                  <a
                    href={href('pdf')}
                    className="btn-secondary text-xs"
                    onClick={() => setOpen(false)}
                  >
                    <FileType className="h-3.5 w-3.5" /> PDF
                  </a>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
