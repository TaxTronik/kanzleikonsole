'use client';

// =============================================================================
// EINE Bearbeitungsfläche für den Sachverhalt — durchgängig von Compose bis
// Review. Immer formatiertes, editierbares Tiptap-Dokument mit Toolbar; die
// Engine-Markierungen liegen als ProseMirror-Decorations darüber.
//
// Keine Modi. Die Interaktion folgt der Auswahl im Dokument:
//   • Cursor steht in einer Markierung  → diese Markierung ins Panel (inspizieren)
//   • Text ist ausgewählt (Ziehen)      → „Eigene Markierung" ins Panel (anlegen)
//   • Toolbar                            → formatieren (verschiebt KEINE Offsets)
//
// Offsets ↔ PM-Positionen über die gemeinsame Serialisierung (doc-text.ts) —
// deckungsgleich mit dem analysierten Plaintext. Beim Formatieren wandern die
// Decorations über tr.mapping korrekt mit. Inhaltliche Textänderungen verschieben
// die Offsets → werden NICHT als Formatierung gespeichert (Hinweis: neu
// analysieren).
// =============================================================================

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Check, Loader2, Lock } from 'lucide-react';
import { useEditor, EditorContent, Extension } from '@tiptap/react';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { docToText, plainRangeToPm, pmPosToPlain, type TextRange } from './doc-text';
import { baseEditorExtensions } from './editor-extensions';
import { FormatToolbar } from './editor-toolbar';
import { type MarkingDTO, FILTER_KEYS, FILTER_LABEL, type FilterKey, herkunftColor } from './_ui';

export interface SubsumtionDocumentHandle {
  setText: (text: string) => void;
  getText: () => string;
  getDoc: () => unknown;
  focus: () => void;
}

export interface ManualSelection {
  start: number;
  end: number;
  text: string;
}

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
  // cursor:pointer → über einer (unterstrichenen) Markierung zeigt die Maus die
  // „Hand" statt des Text-Cursors; signalisiert „anklickbar zum Prüfen".
  let s =
    `text-decoration: underline; text-decoration-color:${color}; text-decoration-thickness:2px;` +
    `text-underline-offset:2px; text-decoration-style:${m.streitig ? 'wavy' : 'solid'}; cursor:pointer;`;
  if (selected) s += 'background: rgba(99,102,241,0.16); border-radius:2px;';
  return s;
}

/** Plain text → HTML (Absätze aus Leerzeilen, <br> für einzelne Umbrüche). */
function textToHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return text.split(/\n{2,}/).map((p) => '<p>' + (p ? esc(p).replace(/\n/g, '<br>') : '') + '</p>').join('') || '<p></p>';
}

interface Props {
  /** Formatierter Sachverhalt (Tiptap-JSON) oder null (Compose / Alt-Analyse). */
  initialDoc: unknown;
  /** Plaintext-Seed, falls kein Doc vorliegt (Compose, Alt-Analyse). */
  initialText?: string;
  /** false = Compose (noch keine Analyse/Markierungen). */
  analyzed: boolean;
  /** false = archiviert/schreibgeschützt. */
  canEdit: boolean;
  /** Der analysierte Plaintext (Review) — Referenz für die „Text geändert"-Erkennung. */
  sourceText?: string;
  textHash?: string;
  totalCount?: number;
  ownCount?: number;
  visibleMarkings?: MarkingDTO[];
  filters?: Set<FilterKey>;
  onToggleFilter?: (k: FilterKey) => void;
  selectedId?: string | null;
  // Auswahl-getriebene Callbacks (Review):
  onSelectMarking?: (id: string | null) => void;
  onSelectionForMarking?: (sel: ManualSelection | null) => void;
  // Compose-Streaming (Analyse-Button / Zähler):
  onTextChange?: (plainText: string) => void;
  // Formatierung speichern (Review):
  saving?: boolean;
  onSaveFormat?: (doc: unknown) => void;
}

export const SubsumtionDocument = forwardRef<SubsumtionDocumentHandle, Props>(function SubsumtionDocument(
  props,
  ref,
) {
  const {
    initialDoc, initialText = '', analyzed, canEdit, sourceText,
    visibleMarkings = [], filters, selectedId = null,
  } = props;

  const [dirty, setDirty] = useState(false);
  const [textChanged, setTextChanged] = useState(false);
  const rangesRef = useRef<TextRange[]>([]);

  // Aktuelle Auswahl-Callbacks/Markierungen für die Editor-Closures (ohne Editor-Neubau).
  const ctxRef = useRef({
    analyzed, canEdit,
    markings: visibleMarkings,
    sourceText: sourceText ?? '',
    onSelectMarking: props.onSelectMarking,
    onSelectionForMarking: props.onSelectionForMarking,
  });
  ctxRef.current.analyzed = analyzed;
  ctxRef.current.canEdit = canEdit;
  ctxRef.current.markings = visibleMarkings;
  ctxRef.current.sourceText = sourceText ?? '';
  ctxRef.current.onSelectMarking = props.onSelectMarking;
  ctxRef.current.onSelectionForMarking = props.onSelectionForMarking;

  const editor = useEditor({
    extensions: [...baseEditorExtensions, MarkDecorations],
    content: initialDoc != null ? (initialDoc as object) : textToHtml(initialText),
    editable: canEdit,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class:
          'tt-content text-sm leading-relaxed focus:outline-none px-3 py-2 ' +
          (analyzed ? 'min-h-[12rem]' : 'min-h-[18rem] max-h-[60vh] overflow-y-auto'),
      },
    },
    onUpdate: ({ editor }) => {
      const { text, ranges } = docToText(editor.state.doc);
      rangesRef.current = ranges;
      props.onTextChange?.(text);
      if (ctxRef.current.analyzed) {
        setDirty(true);
        setTextChanged(text !== ctxRef.current.sourceText);
      }
    },
    onSelectionUpdate: ({ editor }) => {
      const c = ctxRef.current;
      if (!c.analyzed) return;
      const ranges = rangesRef.current.length ? rangesRef.current : docToText(editor.state.doc).ranges;
      const { from, to, empty } = editor.state.selection;

      // Ziehen (nicht-leere Auswahl) + bearbeitbar → eigene Markierung anlegen.
      if (!empty && c.canEdit) {
        const s = pmPosToPlain(ranges, from);
        const e = pmPosToPlain(ranges, to);
        if (s != null && e != null && e > s) {
          c.onSelectionForMarking?.({ start: s, end: e, text: c.sourceText.slice(s, e) });
          c.onSelectMarking?.(null);
          return;
        }
      }

      // Cursor → kleinste überdeckende Markierung inspizieren (oder nichts).
      c.onSelectionForMarking?.(null);
      const plain = pmPosToPlain(ranges, from);
      let best: MarkingDTO | null = null;
      if (plain != null) {
        for (const m of c.markings) {
          if (m.start <= plain && m.end >= plain) {
            if (!best || m.end - m.start < best.end - best.start) best = m;
          }
        }
      }
      c.onSelectMarking?.(best ? best.id : null);
    },
  });

  useImperativeHandle(
    ref,
    () => ({
      setText: (text: string) => {
        editor?.commands.setContent(textToHtml(text));
        if (editor) props.onTextChange?.(docToText(editor.state.doc).text);
      },
      getText: () => (editor ? docToText(editor.state.doc).text : ''),
      getDoc: () => editor?.getJSON() ?? null,
      focus: () => editor?.commands.focus(),
    }),
    [editor, props],
  );

  useEffect(() => {
    editor?.setEditable(canEdit);
  }, [editor, canEdit]);

  // Decorations neu berechnen, wenn sich Markierungen/Auswahl ändern; bei
  // Format-Edits dazwischen wandern sie über tr.mapping korrekt mit.
  useEffect(() => {
    if (!editor) return;
    const { ranges } = docToText(editor.state.doc);
    rangesRef.current = ranges;
    const decos: Decoration[] = [];
    for (const m of visibleMarkings) {
      for (const { from, to } of plainRangeToPm(ranges, m.start, m.end)) {
        decos.push(Decoration.inline(from, to, { style: markStyle(m, m.id === selectedId) }));
      }
    }
    editor.view.dispatch(editor.state.tr.setMeta(markKey, DecorationSet.create(editor.state.doc, decos)));
  }, [editor, visibleMarkings, selectedId]);

  /** Einzelne (harte) Zeilenumbrüche → Leerzeichen; Absätze (\n\n) bleiben. Gegen
   *  Import-Fragmentierung — nur im Compose (verändert den Plaintext). */
  function reflow() {
    if (!editor) return;
    const joined = docToText(editor.state.doc).text.replace(/([^\n])\n([^\n])/g, '$1 $2');
    editor.commands.setContent(textToHtml(joined));
    props.onTextChange?.(docToText(editor.state.doc).text);
  }

  function save() {
    if (!editor) return;
    setDirty(false);
    props.onSaveFormat?.(editor.getJSON());
  }

  const editorBox = (
    <div className="rounded-md border border-default bg-surface">
      {editor && <FormatToolbar editor={editor} onReflow={!analyzed && canEdit ? reflow : undefined} />}
      {editor ? (
        <EditorContent editor={editor} />
      ) : (
        <div className="p-3 text-sm text-muted">Editor lädt …</div>
      )}
    </div>
  );

  // Compose: schlanke Fläche (Titel/Buttons liegen im Workspace drumherum).
  if (!analyzed) return editorBox;

  // Review: Karte mit Kopf, Anzeige-Filtern, Fläche und Speichern-Fußzeile.
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <h2 className="text-sm font-medium text-primary">
          Annotiertes Dokument <span className="text-muted font-normal">(formatiert)</span>
        </h2>
        <p className="text-xs text-muted">
          {props.totalCount ?? 0} Markierungen · {props.ownCount ?? 0} eigene
          {props.textHash ? <> · Hash {props.textHash.slice(0, 12)}…</> : null}
        </p>
      </div>

      {filters && props.onToggleFilter && (
        <div className="flex items-center gap-3 mb-3 flex-wrap text-xs">
          <span className="text-muted uppercase tracking-wide text-[10px]">Anzeigen:</span>
          {FILTER_KEYS.map((k) => (
            <label key={k} className="inline-flex items-center gap-1 cursor-pointer">
              <input type="checkbox" checked={filters.has(k)} onChange={() => props.onToggleFilter!(k)} />
              {FILTER_LABEL[k]}
            </label>
          ))}
        </div>
      )}

      {canEdit ? (
        <p className="mb-2 text-xs text-muted">
          <strong>Klicken</strong> = Markierung prüfen · <strong>Ziehen</strong> = eigene Markierung · Toolbar = formatieren.
        </p>
      ) : (
        <p className="mb-2 text-xs text-muted inline-flex items-center gap-1">
          <Lock className="h-3.5 w-3.5" /> Archiviert — schreibgeschützt. Klicken zeigt die Markierung.
        </p>
      )}

      {editorBox}

      {canEdit && (
        <div className="mt-2 flex items-center gap-3 flex-wrap">
          {textChanged ? (
            <p className="text-xs text-amber-800 dark:text-amber-200">
              Der Text weicht vom analysierten Sachverhalt ab — inhaltliche Änderungen verschieben die
              Markierungen. Für geänderten Text bitte eine <strong>neue Analyse</strong> anlegen; nur
              Formatierung wird gespeichert.
            </p>
          ) : (
            <span className="text-xs text-muted">Formatierung ändern? Markierungen bleiben verankert.</span>
          )}
          <button
            type="button"
            onClick={save}
            disabled={props.saving || !dirty || textChanged}
            className="ml-auto btn-secondary text-xs"
            title={textChanged ? 'Textänderung kann nicht als Formatierung gespeichert werden' : 'Formatierung speichern'}
          >
            {props.saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            Formatierung speichern
          </button>
        </div>
      )}
    </div>
  );
});
