'use client';

import { Pencil, Check } from 'lucide-react';
import {
  type MarkingDTO, FILTER_KEYS, FILTER_LABEL, type FilterKey,
  buildSegments, underlineStyle,
} from './_ui';

// Absoluter Zeichen-Offset eines Selektions-Endpunkts: der Textknoten sitzt in
// einem Segment-<span> mit data-start (= sein Startindex im Quelltext); der
// Offset innerhalb des Knotens kommt dazu.
function resolveOffset(node: Node | null, offset: number): number | null {
  let el: HTMLElement | null = node?.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement | null);
  while (el && el.dataset?.['start'] === undefined) el = el.parentElement;
  if (!el) return null;
  return Number(el.dataset['start']) + offset;
}

export function AnnotatedDocument(props: {
  sourceText: string;
  totalCount: number;
  ownCount: number;
  textHash: string;
  visibleMarkings: MarkingDTO[];
  filters: Set<FilterKey>;
  onToggleFilter: (k: FilterKey) => void;
  editMode: boolean;
  onToggleEdit: () => void;
  selectedId: string | null;
  onSelectMarking: (id: string) => void;
  onManualSelect: (sel: { start: number; end: number; text: string } | null) => void;
}) {
  const { sourceText, visibleMarkings, filters, editMode, selectedId } = props;
  const segments = buildSegments(sourceText, visibleMarkings);

  function captureSelection() {
    if (!editMode) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) { props.onManualSelect(null); return; }
    const a = resolveOffset(sel.anchorNode, sel.anchorOffset);
    const f = resolveOffset(sel.focusNode, sel.focusOffset);
    if (a == null || f == null) return;
    const start = Math.min(a, f);
    const end = Math.max(a, f);
    if (end > start) props.onManualSelect({ start, end, text: sourceText.slice(start, end) });
  }

  // Laufender Offset, damit jedes Segment-<span> sein data-start trägt.
  let cursor = 0;

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <h2 className="text-sm font-medium text-primary">Annotiertes Dokument</h2>
        <p className="text-xs text-muted">
          {props.totalCount} Markierungen · {props.ownCount} eigene · Hash {props.textHash.slice(0, 12)}…
        </p>
      </div>

      <div className="flex items-center gap-3 mb-3 flex-wrap text-xs">
        <span className="text-muted uppercase tracking-wide text-[10px]">Anzeigen:</span>
        {FILTER_KEYS.map((k) => (
          <label key={k} className="inline-flex items-center gap-1 cursor-pointer">
            <input type="checkbox" checked={filters.has(k)} onChange={() => props.onToggleFilter(k)} />
            {FILTER_LABEL[k]}
          </label>
        ))}
        <button
          type="button"
          onClick={props.onToggleEdit}
          className={'ml-auto text-xs ' + (editMode ? 'btn-primary' : 'btn-secondary')}
        >
          {editMode ? <Check className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
          {editMode ? 'Edit-Modus aktiv' : 'Edit-Modus'}
        </button>
      </div>

      {editMode && (
        <p className="mb-2 text-xs text-amber-800 dark:text-amber-200">
          Textstelle <strong>markieren</strong> (mit der Maus ziehen) → rechts Begriff, Farbe, Label
          und (optional) Norm setzen und speichern. Die Hervorhebungen bleiben sichtbar.
        </p>
      )}

      <div
        onMouseUp={captureSelection}
        className={
          'whitespace-pre-wrap text-sm leading-loose ' +
          (editMode ? 'cursor-text rounded-md ring-1 ring-amber-300 dark:ring-amber-700 p-2' : '')
        }
      >
        {segments.map((seg, i) => {
          const segStart = cursor;
          cursor += seg.text.length;
          if (!seg.marking) {
            return (
              <span key={i} data-start={segStart}>
                {seg.text}
              </span>
            );
          }
          return (
            <span
              key={i}
              data-start={segStart}
              onClick={() => !editMode && props.onSelectMarking(seg.marking!.id)}
              style={underlineStyle(seg.marking)}
              className={
                (editMode ? '' : 'cursor-pointer ') +
                (seg.marking.id === selectedId ? 'bg-brand-100 dark:bg-brand-900/40 rounded-sm' : '')
              }
              title={`${seg.marking.begriff}${seg.marking.label ? ' · ' + seg.marking.label : ''}`}
            >
              {seg.text}
            </span>
          );
        })}
      </div>
    </div>
  );
}
