'use client';

import { useRef } from 'react';
import { Pencil, Check } from 'lucide-react';
import {
  type MarkingDTO, FILTER_KEYS, FILTER_LABEL, type FilterKey,
  buildSegments, underlineStyle,
} from './_ui';

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
  const taRef = useRef<HTMLTextAreaElement>(null);
  const segments = buildSegments(sourceText, visibleMarkings);

  function captureSelection() {
    const ta = taRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    if (end > start) props.onManualSelect({ start, end, text: sourceText.slice(start, end) });
    else props.onManualSelect(null);
  }

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

      {editMode ? (
        <div className="space-y-2">
          <div className="rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-900 dark:text-amber-100">
            <strong>Edit-Modus aktiv.</strong> Textstelle markieren → rechts Begriff, Farbe, Label,
            Notiz und (optional) Norm wählen und speichern.
          </div>
          <textarea
            ref={taRef}
            readOnly
            value={sourceText}
            onMouseUp={captureSelection}
            onKeyUp={captureSelection}
            rows={20}
            className="w-full rounded-md border border-default bg-surface px-3 py-2 text-sm font-mono leading-relaxed"
          />
        </div>
      ) : (
        <div className="whitespace-pre-wrap text-sm leading-loose">
          {segments.map((seg, i) =>
            seg.marking ? (
              <span
                key={i}
                onClick={() => props.onSelectMarking(seg.marking!.id)}
                style={underlineStyle(seg.marking)}
                className={
                  'cursor-pointer ' +
                  (seg.marking.id === selectedId ? 'bg-brand-100 dark:bg-brand-900/40 rounded-sm' : '')
                }
                title={`${seg.marking.begriff}${seg.marking.label ? ' · ' + seg.marking.label : ''}`}
              >
                {seg.text}
              </span>
            ) : (
              <span key={i}>{seg.text}</span>
            ),
          )}
        </div>
      )}
    </div>
  );
}
