'use client';

// =============================================================================
// Formatierte Review-Ansicht: der Rich-Sachverhalt (Tiptap, read-only) mit den
// Engine-Markierungen als ProseMirror-Decorations. Offsets ↔ PM-Positionen über
// die gemeinsame Serialisierung (doc-text.ts) — bauartbedingt deckungsgleich mit
// dem analysierten Plaintext. Klick auf eine markierte Stelle → Panel rechts.
// =============================================================================

import { useEffect, useRef } from 'react';
import { Pencil, Check } from 'lucide-react';
import { useEditor, EditorContent, Extension } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { docToText, plainRangeToPm, pmPosToPlain, type TextRange } from './doc-text';
import { type MarkingDTO, FILTER_KEYS, FILTER_LABEL, type FilterKey, herkunftColor } from './_ui';

const markKey = new PluginKey('riskMarks');

const MarkDecorations = Extension.create({
  name: 'riskMarkDecorations',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: markKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, old) {
            const meta = tr.getMeta(markKey) as DecorationSet | undefined;
            if (meta) return meta;
            return old.map(tr.mapping, tr.doc);
          },
        },
        props: { decorations: (state) => markKey.getState(state) },
      }),
    ];
  },
});

function markStyle(m: MarkingDTO, selected: boolean): string {
  const color = m.streitig ? '#ef4444' : herkunftColor(m.herkunft);
  let s =
    `text-decoration: underline; text-decoration-color:${color}; text-decoration-thickness:2px;` +
    `text-underline-offset:2px; text-decoration-style:${m.streitig ? 'wavy' : 'solid'}; cursor:pointer;`;
  if (selected) s += 'background: rgba(99,102,241,0.16); border-radius:2px;';
  return s;
}

export function AnnotatedRichDocument(props: {
  sourceDoc: unknown;
  totalCount: number;
  ownCount: number;
  textHash: string;
  visibleMarkings: MarkingDTO[];
  filters: Set<FilterKey>;
  onToggleFilter: (k: FilterKey) => void;
  onToggleEdit: () => void;
  selectedId: string | null;
  onSelectMarking: (id: string) => void;
}) {
  const { sourceDoc, visibleMarkings, filters, selectedId } = props;

  // Klick-Kontext (aktuelle Markierungen + Mapping) für die handleClick-Closure.
  const clickRef = useRef<{ ranges: TextRange[]; markings: MarkingDTO[]; onSelect: (id: string) => void }>({
    ranges: [],
    markings: visibleMarkings,
    onSelect: props.onSelectMarking,
  });
  clickRef.current.markings = visibleMarkings;
  clickRef.current.onSelect = props.onSelectMarking;

  const editor = useEditor({
    extensions: [StarterKit, MarkDecorations],
    content: (sourceDoc as object) ?? '<p></p>',
    editable: false,
    immediatelyRender: false,
    editorProps: {
      attributes: { class: 'tt-content text-sm leading-relaxed focus:outline-none' },
      handleClick(_view, pos) {
        const { ranges, markings, onSelect } = clickRef.current;
        const plain = pmPosToPlain(ranges, pos);
        if (plain == null) return false;
        // kleinste überdeckende Markierung gewinnt
        let best: MarkingDTO | null = null;
        for (const m of markings) {
          if (m.start <= plain && m.end >= plain) {
            if (!best || m.end - m.start < best.end - best.start) best = m;
          }
        }
        if (best) {
          onSelect(best.id);
          return true;
        }
        return false;
      },
    },
  });

  // Decorations neu berechnen, wenn sich Markierungen/Filter/Auswahl ändern.
  useEffect(() => {
    if (!editor) return;
    const { ranges } = docToText(editor.state.doc);
    clickRef.current.ranges = ranges;
    const decos: Decoration[] = [];
    for (const m of visibleMarkings) {
      for (const { from, to } of plainRangeToPm(ranges, m.start, m.end)) {
        decos.push(Decoration.inline(from, to, { style: markStyle(m, m.id === selectedId) }));
      }
    }
    editor.view.dispatch(editor.state.tr.setMeta(markKey, DecorationSet.create(editor.state.doc, decos)));
  }, [editor, visibleMarkings, selectedId]);

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <h2 className="text-sm font-medium text-primary">Annotiertes Dokument <span className="text-muted font-normal">(formatiert)</span></h2>
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
        <button type="button" onClick={props.onToggleEdit} className="ml-auto text-xs btn-secondary" title="Eigene Markierung setzen (Plaintext-Modus)">
          <Pencil className="h-3.5 w-3.5" /> Eigene Markierung
        </button>
      </div>

      {editor ? (
        <EditorContent editor={editor} />
      ) : (
        <div className="text-sm text-muted inline-flex items-center gap-1"><Check className="h-3.5 w-3.5" /> lädt …</div>
      )}
    </div>
  );
}
