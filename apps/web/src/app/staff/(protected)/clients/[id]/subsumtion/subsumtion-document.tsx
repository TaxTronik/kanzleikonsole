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
import { useEditor, EditorContent, Extension, type Editor } from '@tiptap/react';
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

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function markStyle(m: MarkingDTO, selected: boolean): string {
  const color = m.streitig ? '#ef4444' : herkunftColor(m.herkunft);
  // Hintergrund-Tönung in der Herkunftsfarbe ZUSÄTZLICH zur Unterstreichung →
  // deutlich sichtbar; ausgewählt = kräftiger Indigo-Hintergrund. cursor:pointer
  // signalisiert „anklickbar zum Prüfen".
  const bg = selected ? 'rgba(99, 102, 241, 0.24)' : hexToRgba(color, 0.16);
  return (
    `text-decoration: underline; text-decoration-color:${color}; text-decoration-thickness:2px;` +
    `text-underline-offset:2px; text-decoration-style:${m.streitig ? 'wavy' : 'solid'}; cursor:pointer;` +
    `background:${bg}; border-radius:2px;`
  );
}

/** Position der schwebenden Formatier-Leiste relativ zur Editor-Box (über bzw.
 *  — falls oben kein Platz — unter der Auswahl, horizontal zentriert). */
function flyoverFor(editor: Editor, box: DOMRect, from: number, to: number) {
  const a = editor.view.coordsAtPos(from);
  const b = editor.view.coordsAtPos(to);
  const selTop = Math.min(a.top, b.top);
  const selBottom = Math.max(a.bottom, b.bottom);
  const above = selTop - box.top > 44;
  return {
    top: above ? selTop - box.top - 8 : selBottom - box.top + 8,
    left: Math.max(72, Math.min(box.width - 72, (a.left + b.left) / 2 - box.left)),
    placement: above ? ('above' as const) : ('below' as const),
  };
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
  // Formatierung automatisch speichern (Review, on-the-fly, debounced). Liefert
  // das Ergebnis für die Speicher-Status-Anzeige zurück.
  onSaveFormat?: (doc: unknown) => Promise<{ ok: boolean; error?: string }>;
}

export const SubsumtionDocument = forwardRef<SubsumtionDocumentHandle, Props>(function SubsumtionDocument(
  props,
  ref,
) {
  const {
    initialDoc, initialText = '', analyzed, canEdit, sourceText,
    visibleMarkings = [], filters, selectedId = null,
  } = props;

  const [textChanged, setTextChanged] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>('idle');
  const rangesRef = useRef<TextRange[]>([]);
  // Schwebende Formatier-Leiste (Review): erscheint über/unter der Auswahl.
  const [flyover, setFlyover] = useState<{ top: number; left: number; placement: 'above' | 'below' } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  // true, solange mit der Maus gezogen wird → Leiste erst nach dem Loslassen.
  const draggingRef = useRef(false);

  // Auto-Save (Formatierung on-the-fly, debounced).
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const pendingDocRef = useRef<unknown>(null);

  // Aktuelle Auswahl-Callbacks/Markierungen für die Editor-Closures (ohne Editor-Neubau).
  const ctxRef = useRef({
    analyzed, canEdit,
    markings: visibleMarkings,
    sourceText: sourceText ?? '',
    onSelectMarking: props.onSelectMarking,
    onSelectionForMarking: props.onSelectionForMarking,
    onSaveFormat: props.onSaveFormat,
  });
  ctxRef.current.analyzed = analyzed;
  ctxRef.current.canEdit = canEdit;
  ctxRef.current.markings = visibleMarkings;
  ctxRef.current.sourceText = sourceText ?? '';
  ctxRef.current.onSelectMarking = props.onSelectMarking;
  ctxRef.current.onSelectionForMarking = props.onSelectionForMarking;
  ctxRef.current.onSaveFormat = props.onSaveFormat;

  // Debounce-Logik in Refs (immer frisch), damit die stabile onUpdate-Closure sie
  // ohne Stale-Capture aufrufen kann.
  const flushRef = useRef<() => void>(() => {});
  const scheduleRef = useRef<(doc: unknown, changed: boolean) => void>(() => {});
  flushRef.current = async () => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    if (savingRef.current) return; // läuft schon → der nächste Lauf holt's nach
    const doc = pendingDocRef.current;
    const save = ctxRef.current.onSaveFormat;
    if (doc == null || !save) return;
    pendingDocRef.current = null;
    savingRef.current = true;
    setSaveState('saving');
    const ok = await save(doc).then((r) => r.ok).catch(() => false);
    savingRef.current = false;
    setSaveState(ok ? 'saved' : 'error');
    if (ok && pendingDocRef.current != null) flushRef.current(); // zwischenzeitliche Änderung
  };
  scheduleRef.current = (doc, changed) => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    // Nur Formatierung auto-speichern; Textänderung → Warnung, KEIN Save (Offsets).
    if (changed || !ctxRef.current.canEdit) return;
    pendingDocRef.current = doc;
    setSaveState('dirty');
    saveTimer.current = setTimeout(() => flushRef.current(), 1000);
  };

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
      // Editor verlassen → ausstehende Formatierung sofort speichern (statt Debounce).
      handleDOMEvents: { blur: () => { flushRef.current(); return false; } },
    },
    onUpdate: ({ editor }) => {
      const { text, ranges } = docToText(editor.state.doc);
      rangesRef.current = ranges;
      props.onTextChange?.(text);
      if (ctxRef.current.analyzed) {
        const changed = text !== ctxRef.current.sourceText;
        setTextChanged(changed);
        // Formatierung on-the-fly speichern (debounced).
        scheduleRef.current(editor.getJSON(), changed);
      }
    },
    onSelectionUpdate: ({ editor }) => {
      const c = ctxRef.current;
      if (!c.analyzed) return;
      const ranges = rangesRef.current.length ? rangesRef.current : docToText(editor.state.doc).ranges;
      const { from, to, empty } = editor.state.selection;

      // Ziehen (nicht-leere Auswahl) + bearbeitbar → eigene Markierung anlegen +
      // schwebende Formatier-Leiste über der Auswahl.
      if (!empty && c.canEdit) {
        const s = pmPosToPlain(ranges, from);
        const e = pmPosToPlain(ranges, to);
        if (s != null && e != null && e > s) {
          c.onSelectionForMarking?.({ start: s, end: e, text: c.sourceText.slice(s, e) });
          c.onSelectMarking?.(null);
          // Bei Maus-Auswahl erst nach dem Loslassen (mouseup-Handler) zeigen —
          // während des Ziehens ausgeblendet. Tastatur-Auswahl (kein Drag) sofort.
          const box = boxRef.current?.getBoundingClientRect();
          setFlyover(box && !draggingRef.current ? flyoverFor(editor, box, from, to) : null);
          return;
        }
      }

      // Cursor → kleinste überdeckende Markierung inspizieren (oder nichts).
      setFlyover(null);
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

  // Flyover-Leiste erst beim Loslassen der Maus zeigen: während des Ziehens
  // (mousedown im Editor … mouseup irgendwo) bleibt sie aus; am Ende wird sie für
  // die fertige Auswahl gesetzt. mouseup am document, da der Zug außerhalb enden kann.
  useEffect(() => {
    if (!editor || !analyzed) return;
    const dom = editor.view.dom;
    const onDown = () => { draggingRef.current = true; setFlyover(null); };
    const onUp = () => {
      draggingRef.current = false;
      const { from, to, empty } = editor.state.selection;
      const box = boxRef.current?.getBoundingClientRect();
      if (!empty && canEdit && box) setFlyover(flyoverFor(editor, box, from, to));
    };
    dom.addEventListener('mousedown', onDown);
    document.addEventListener('mouseup', onUp);
    return () => {
      dom.removeEventListener('mousedown', onDown);
      document.removeEventListener('mouseup', onUp);
    };
  }, [editor, analyzed, canEdit]);

  /** Einzelne (harte) Zeilenumbrüche → Leerzeichen; Absätze (\n\n) bleiben. Gegen
   *  Import-Fragmentierung — nur im Compose (verändert den Plaintext). */
  function reflow() {
    if (!editor) return;
    const joined = docToText(editor.state.doc).text.replace(/([^\n])\n([^\n])/g, '$1 $2');
    editor.commands.setContent(textToHtml(joined));
    props.onTextChange?.(docToText(editor.state.doc).text);
  }

  // Beim Unmount (z. B. Wegnavigieren) ausstehende Formatierung noch sichern.
  useEffect(() => () => { if (pendingDocRef.current != null) flushRef.current(); }, []);

  // Tiptap rendert NUR client-seitig (immediatelyRender:false → editor ist auf dem
  // Server und im ersten Client-Render null). Bis dahin ein stabiler Platzhalter,
  // der auf beiden Seiten identisch ist — sonst weichen die Editor-/Folge-Knoten
  // bei der Hydration ab. Erst wenn der Editor existiert (nach mount), bauen wir
  // die volle Fläche auf.
  if (!editor) {
    return (
      <div className={analyzed ? 'card p-4 text-sm text-muted' : 'rounded-md border border-default bg-surface p-3 text-sm text-muted'}>
        Editor lädt …
      </div>
    );
  }

  const editorBox = (
    <div ref={boxRef} className="relative rounded-md border border-default bg-surface">
      {/* Compose: feste Leiste (beim Schreiben immer sichtbar). Review: keine feste
          Leiste — die schwebende erscheint bei Auswahl (siehe unten). */}
      {!analyzed && <FormatToolbar editor={editor} onReflow={canEdit ? reflow : undefined} />}
      <EditorContent editor={editor} />
      {analyzed && canEdit && flyover && (
        <div
          className="absolute z-20"
          style={{
            top: flyover.top,
            left: flyover.left,
            transform: flyover.placement === 'above' ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
          }}
        >
          <div className="rounded-md border border-default bg-surface shadow-lg">
            <FormatToolbar editor={editor} bordered={false} />
          </div>
        </div>
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
          <strong>Klicken</strong> = Markierung prüfen · <strong>Auswählen</strong> = formatieren (Leiste erscheint) & eigene Markierung.
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
              Markierungen. Für geänderten Text bitte eine <strong>neue Analyse</strong> anlegen; reine
              Formatierung wird automatisch gespeichert.
            </p>
          ) : (
            <span className="ml-auto text-xs text-muted inline-flex items-center gap-1">
              {saveState === 'saving' ? (
                <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Speichert …</>
              ) : saveState === 'saved' ? (
                <><Check className="h-3.5 w-3.5 text-emerald-600" /> Formatierung gespeichert</>
              ) : saveState === 'error' ? (
                <span className="text-red-600">Speichern fehlgeschlagen — wird erneut versucht</span>
              ) : (
                'Formatierung wird automatisch gespeichert.'
              )}
            </span>
          )}
        </div>
      )}
    </div>
  );
});
