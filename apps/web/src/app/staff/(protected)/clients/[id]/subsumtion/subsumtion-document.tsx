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
import {
  Check,
  Loader2,
  Lock,
  Maximize2,
  Minimize2,
  MousePointer2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useEditor, EditorContent, Extension, type Editor } from '@tiptap/react';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { docToText, plainRangeToPm, pmPosToPlain, type TextRange } from './doc-text';
import { baseEditorExtensions } from './editor-extensions';
import { FormatToolbar } from './editor-toolbar';
import { buildSegments, segmentStyle } from './marking-style';
import { type MarkingDTO, FILTER_KEYS, FILTER_LABEL, type FilterKey } from './_ui';

export interface SubsumtionDocumentHandle {
  setText: (text: string) => void;
  getText: () => string;
  getDoc: () => unknown;
  focus: () => void;
  /** Cursor an den Anfang einer Markierung setzen + in den Sichtbereich scrollen
   *  (für die Navigation aus der Markierungsliste). Wählt sie dadurch aus. */
  revealMarking: (start: number) => void;
}

export interface ManualSelection {
  start: number;
  end: number;
  text: string;
}

// Zoom der Lesefläche (Schriftgröße + Markierungs-Geometrie skalieren gemeinsam
// über die CSS-Var --tt-zoom). Diskrete Schritte, geklemmt.
const ZOOM_MIN = 0.85;
const ZOOM_MAX = 2;
const ZOOM_STEP = 0.15;
const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));

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
  return (
    text
      .split(/\n{2,}/)
      .map((p) => '<p>' + (p ? esc(p).replace(/\n/g, '<br>') : '') + '</p>')
      .join('') || '<p></p>'
  );
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
  /** Kanzleiweiter Startwert für die zusätzliche Leiste direkt an der Auswahl. */
  floatingToolbarDefault?: boolean;
  // Vollbild: Status + Umschalter. Das Layout-Overlay liegt im Workspace (er
  // besitzt Dokument + Panel); hier nur der Button im Kopf.
  expanded?: boolean;
  onToggleExpand?: () => void;
}

export const SubsumtionDocument = forwardRef<SubsumtionDocumentHandle, Props>(
  function SubsumtionDocument(props, ref) {
    const {
      initialDoc,
      initialText = '',
      analyzed,
      canEdit,
      sourceText,
      visibleMarkings = [],
      filters,
      selectedId = null,
    } = props;

    const [textChanged, setTextChanged] = useState(false);
    const [saveState, setSaveState] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>(
      'idle',
    );
    const rangesRef = useRef<TextRange[]>([]);
    // Schwebende Formatier-Leiste (Review): erscheint über/unter der Auswahl.
    const [flyover, setFlyover] = useState<{
      top: number;
      left: number;
      placement: 'above' | 'below';
    } | null>(null);
    const [floatingToolbarEnabled, setFloatingToolbarEnabled] = useState(
      props.floatingToolbarDefault ?? false,
    );
    // Markierung unter der Maus → ihre ganze Spanne wird hervorgehoben.
    const [hoveredId, setHoveredId] = useState<string | null>(null);
    // Zoom der Lesefläche (1 = 100%).
    const [zoom, setZoom] = useState(1);
    const boxRef = useRef<HTMLDivElement>(null);
    // true, solange mit der Maus gezogen wird → Leiste erst nach dem Loslassen.
    const draggingRef = useRef(false);

    // Auto-Save (Formatierung on-the-fly, debounced).
    const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const savingRef = useRef(false);
    const pendingDocRef = useRef<unknown>(null);

    // Aktuelle Auswahl-Callbacks/Markierungen für die Editor-Closures (ohne Editor-Neubau).
    const ctxRef = useRef({
      analyzed,
      canEdit,
      markings: visibleMarkings,
      sourceText: sourceText ?? '',
      onSelectMarking: props.onSelectMarking,
      onSelectionForMarking: props.onSelectionForMarking,
      onSaveFormat: props.onSaveFormat,
      floatingToolbarEnabled,
    });
    ctxRef.current.analyzed = analyzed;
    ctxRef.current.canEdit = canEdit;
    ctxRef.current.markings = visibleMarkings;
    ctxRef.current.sourceText = sourceText ?? '';
    ctxRef.current.onSelectMarking = props.onSelectMarking;
    ctxRef.current.onSelectionForMarking = props.onSelectionForMarking;
    ctxRef.current.onSaveFormat = props.onSaveFormat;
    ctxRef.current.floatingToolbarEnabled = floatingToolbarEnabled;

    // Debounce-Logik in Refs (immer frisch), damit die stabile onUpdate-Closure sie
    // ohne Stale-Capture aufrufen kann.
    const flushRef = useRef<() => void>(() => {});
    const scheduleRef = useRef<(doc: unknown, changed: boolean) => void>(() => {});
    flushRef.current = async () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      if (savingRef.current) return; // läuft schon → der nächste Lauf holt's nach
      const doc = pendingDocRef.current;
      const save = ctxRef.current.onSaveFormat;
      if (doc == null || !save) return;
      pendingDocRef.current = null;
      savingRef.current = true;
      setSaveState('saving');
      const ok = await save(doc)
        .then((r) => r.ok)
        .catch(() => false);
      savingRef.current = false;
      setSaveState(ok ? 'saved' : 'error');
      if (ok && pendingDocRef.current != null) flushRef.current(); // zwischenzeitliche Änderung
    };
    scheduleRef.current = (doc, changed) => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
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
            'tt-content text-sm focus:outline-none ' +
            // Review: luftigere Zeilen → Platz für die gestapelten Unterstreichungs-Spuren.
            (analyzed
              ? 'min-h-[56vh] px-6 py-5 text-[15px] leading-8'
              : 'min-h-[64vh] p-8 text-[15px] leading-7'),
        },
        // Editor verlassen → ausstehende Formatierung sofort speichern (statt Debounce).
        handleDOMEvents: {
          blur: () => {
            flushRef.current();
            return false;
          },
        },
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
        const ranges = rangesRef.current.length
          ? rangesRef.current
          : docToText(editor.state.doc).ranges;
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
            setFlyover(
              box && !draggingRef.current && c.floatingToolbarEnabled
                ? flyoverFor(editor, box, from, to)
                : null,
            );
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
        revealMarking: (start: number) => {
          if (!editor) return;
          const ranges = rangesRef.current.length
            ? rangesRef.current
            : docToText(editor.state.doc).ranges;
          const mapped = plainRangeToPm(ranges, start, start);
          const pos = mapped[0]?.from;
          if (pos == null) return;
          const sel = TextSelection.create(editor.state.doc, pos);
          // Cursor setzen (→ onSelectionUpdate wählt die Markierung) + hinscrollen.
          editor.view.dispatch(editor.state.tr.setSelection(sel).scrollIntoView());
          editor.view.focus();
        },
      }),
      [editor, props],
    );

    useEffect(() => {
      editor?.setEditable(canEdit);
    }, [editor, canEdit]);

    // Zoom auf das Editor-DOM legen: Schriftgröße + CSS-Var --tt-zoom (treibt die
    // Markierungs-Geometrie in marking-style; beide skalieren gemeinsam). Bei 1
    // zurücksetzen → die text-sm-Klasse + Default-Geometrie greifen wieder.
    useEffect(() => {
      if (!editor) return;
      const dom = editor.view.dom as HTMLElement;
      if (zoom === 1) {
        dom.style.removeProperty('--tt-zoom');
        dom.style.removeProperty('font-size');
      } else {
        dom.style.setProperty('--tt-zoom', String(zoom));
        dom.style.fontSize = `calc(0.875rem * ${zoom})`;
      }
    }, [editor, zoom]);

    // Decorations neu berechnen, wenn sich Markierungen/Auswahl ändern; bei
    // Format-Edits dazwischen wandern sie über tr.mapping korrekt mit.
    useEffect(() => {
      if (!editor) return;
      const { ranges } = docToText(editor.state.doc);
      rangesRef.current = ranges;
      // Disjunkte Segmente (an jeder Markierungsgrenze) → keine überlappenden
      // Decorations → ProseMirror verschmilzt keine Styles. Pro Segment EINE
      // Decoration mit mehreren Linien-Layern + einer Füllung (siehe marking-style).
      const decos: Decoration[] = [];
      for (const seg of buildSegments(visibleMarkings)) {
        const style = segmentStyle(seg.covering, selectedId, hoveredId);
        // a11y: die überdeckenden Begriffe als Label (Screenreader; Spans sind sonst
        // nur visuell). role=mark kennzeichnet hervorgehobenen Text.
        const label = seg.covering
          .map((c) => c.m.begriff)
          .filter(Boolean)
          .join(', ');
        const attrs = label
          ? { style, role: 'mark', 'aria-label': `Markierung: ${label}` }
          : { style };
        for (const { from, to } of plainRangeToPm(ranges, seg.start, seg.end)) {
          decos.push(Decoration.inline(from, to, attrs));
        }
      }
      editor.view.dispatch(
        editor.state.tr.setMeta(markKey, DecorationSet.create(editor.state.doc, decos)),
      );
    }, [editor, visibleMarkings, selectedId, hoveredId]);

    // Flyover-Leiste erst beim Loslassen der Maus zeigen: während des Ziehens
    // (mousedown im Editor … mouseup irgendwo) bleibt sie aus; am Ende wird sie für
    // die fertige Auswahl gesetzt. mouseup am document, da der Zug außerhalb enden kann.
    useEffect(() => {
      if (!editor || !analyzed) return;
      const dom = editor.view.dom;
      const onDown = () => {
        draggingRef.current = true;
        setFlyover(null);
      };
      const onUp = () => {
        draggingRef.current = false;
        const { from, to, empty } = editor.state.selection;
        const box = boxRef.current?.getBoundingClientRect();
        if (!empty && canEdit && ctxRef.current.floatingToolbarEnabled && box) {
          setFlyover(flyoverFor(editor, box, from, to));
        }
      };
      dom.addEventListener('mousedown', onDown);
      document.addEventListener('mouseup', onUp);
      return () => {
        dom.removeEventListener('mousedown', onDown);
        document.removeEventListener('mouseup', onUp);
      };
    }, [editor, analyzed, canEdit]);

    // Hover über einer Markierung → ihre ganze Spanne hervorheben (kleinste
    // überdeckende; rAF-gedrosselt, setHoveredId nur bei Wechsel → re-rendert die
    // Decorations nicht bei jedem Pixel).
    useEffect(() => {
      if (!editor || !analyzed) return;
      const dom = editor.view.dom;
      let ticking = false;
      const update = (x: number, y: number) => {
        const pos = editor.view.posAtCoords({ left: x, top: y });
        let id: string | null = null;
        if (pos) {
          const plain = pmPosToPlain(rangesRef.current, pos.pos);
          if (plain != null) {
            let best: MarkingDTO | null = null;
            for (const m of ctxRef.current.markings) {
              if (
                m.start <= plain &&
                m.end >= plain &&
                (!best || m.end - m.start < best.end - best.start)
              )
                best = m;
            }
            id = best?.id ?? null;
          }
        }
        setHoveredId((cur) => (cur === id ? cur : id));
      };
      const onMove = (e: MouseEvent) => {
        const x = e.clientX,
          y = e.clientY;
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
          ticking = false;
          update(x, y);
        });
      };
      const onLeave = () => setHoveredId(null);
      dom.addEventListener('mousemove', onMove);
      dom.addEventListener('mouseleave', onLeave);
      return () => {
        dom.removeEventListener('mousemove', onMove);
        dom.removeEventListener('mouseleave', onLeave);
      };
    }, [editor, analyzed]);

    /** Einzelne (harte) Zeilenumbrüche → Leerzeichen; Absätze (\n\n) bleiben. Gegen
     *  Import-Fragmentierung — nur im Compose (verändert den Plaintext). */
    function reflow() {
      if (!editor) return;
      const joined = docToText(editor.state.doc).text.replace(/([^\n])\n([^\n])/g, '$1 $2');
      editor.commands.setContent(textToHtml(joined));
      props.onTextChange?.(docToText(editor.state.doc).text);
    }

    // Beim Unmount (z. B. Wegnavigieren) ausstehende Formatierung noch sichern.
    useEffect(
      () => () => {
        if (pendingDocRef.current != null) flushRef.current();
      },
      [],
    );

    // Tiptap rendert NUR client-seitig (immediatelyRender:false → editor ist auf dem
    // Server und im ersten Client-Render null). Bis dahin ein stabiler Platzhalter,
    // der auf beiden Seiten identisch ist — sonst weichen die Editor-/Folge-Knoten
    // bei der Hydration ab. Erst wenn der Editor existiert (nach mount), bauen wir
    // die volle Fläche auf.
    if (!editor) {
      return (
        <div
          className={
            analyzed
              ? 'card p-4 text-sm text-muted'
              : 'rounded-md border border-default bg-surface p-3 text-sm text-muted'
          }
        >
          Editor lädt …
        </div>
      );
    }

    const editorBox = (
      <div
        ref={boxRef}
        className={
          analyzed
            ? 'relative rounded-md border border-default bg-surface'
            : 'relative min-h-[64vh] bg-surface'
        }
      >
        {canEdit && (
          <div className={analyzed ? 'sticky top-0 z-10 rounded-t-md bg-surface' : undefined}>
            <FormatToolbar editor={editor} onReflow={!analyzed && canEdit ? reflow : undefined} />
          </div>
        )}
        <EditorContent editor={editor} />
        {analyzed && canEdit && floatingToolbarEnabled && flyover && (
          <div
            className="absolute z-20"
            style={{
              top: flyover.top,
              left: flyover.left,
              transform:
                flyover.placement === 'above' ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
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
          <div className="flex items-center gap-3 flex-wrap">
            <p className="text-xs text-muted">
              {props.totalCount ?? 0} Markierungen · {props.ownCount ?? 0} eigene
              {props.textHash ? <> · Hash {props.textHash.slice(0, 12)}…</> : null}
            </p>
            {/* Zoom (Schrift + Markierungen skalieren gemeinsam) */}
            <div className="inline-flex items-center rounded-md border border-default">
              <button
                type="button"
                onClick={() => setZoom((z) => clampZoom(z - ZOOM_STEP))}
                disabled={zoom <= ZOOM_MIN}
                className="p-1 text-disabled hover:text-secondary disabled:opacity-40"
                title="Verkleinern"
              >
                <ZoomOut className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setZoom(1)}
                className="px-1 w-10 text-center text-[11px] tabular-nums text-secondary hover:text-primary"
                title="Zoom zurücksetzen"
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                onClick={() => setZoom((z) => clampZoom(z + ZOOM_STEP))}
                disabled={zoom >= ZOOM_MAX}
                className="p-1 text-disabled hover:text-secondary disabled:opacity-40"
                title="Vergrößern"
              >
                <ZoomIn className="h-3.5 w-3.5" />
              </button>
            </div>
            {canEdit && (
              <button
                type="button"
                aria-pressed={floatingToolbarEnabled}
                onClick={() => {
                  setFloatingToolbarEnabled((enabled) => !enabled);
                  setFlyover(null);
                }}
                className={floatingToolbarEnabled ? 'btn-primary text-xs' : 'btn-secondary text-xs'}
                title="Zusätzliche Formatierleiste direkt an der Textauswahl ein- oder ausschalten"
              >
                <MousePointer2 className="h-3.5 w-3.5" />
                Schwebende Leiste
              </button>
            )}
            {/* Vollbild */}
            {props.onToggleExpand && (
              <button
                type="button"
                onClick={props.onToggleExpand}
                className="btn-secondary text-xs"
                title={props.expanded ? 'Vollbild verlassen (Esc)' : 'Vollbild'}
              >
                {props.expanded ? (
                  <Minimize2 className="h-3.5 w-3.5" />
                ) : (
                  <Maximize2 className="h-3.5 w-3.5" />
                )}
                {props.expanded ? 'Verlassen' : 'Vollbild'}
              </button>
            )}
          </div>
        </div>

        {filters && props.onToggleFilter && (
          <div className="flex items-center gap-3 mb-3 flex-wrap text-xs">
            <span className="text-muted uppercase tracking-wide text-[10px]">Anzeigen:</span>
            {FILTER_KEYS.map((k) => (
              <label key={k} className="inline-flex items-center gap-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={filters.has(k)}
                  onChange={() => props.onToggleFilter!(k)}
                />
                {FILTER_LABEL[k]}
              </label>
            ))}
          </div>
        )}

        {canEdit ? (
          <p className="mb-2 text-xs text-muted">
            <strong>Klicken</strong> = Markierung prüfen · <strong>Auswählen</strong> = formatieren
            und eigene Markierung anlegen. Die feste Formatierleiste bleibt sichtbar.
          </p>
        ) : (
          <p className="mb-2 text-xs text-muted inline-flex items-center gap-1">
            <Lock className="h-3.5 w-3.5" /> Archiviert — schreibgeschützt. Klicken zeigt die
            Markierung.
          </p>
        )}

        {editorBox}

        {canEdit && (
          <div className="mt-2 flex items-center gap-3 flex-wrap">
            {textChanged ? (
              <p className="text-xs text-amber-800 dark:text-amber-200">
                Der Text weicht vom analysierten Sachverhalt ab — inhaltliche Änderungen verschieben
                die Markierungen. Für geänderten Text bitte eine <strong>neue Analyse</strong>{' '}
                anlegen; reine Formatierung wird automatisch gespeichert.
              </p>
            ) : (
              <span className="ml-auto text-xs text-muted inline-flex items-center gap-1">
                {saveState === 'saving' ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Speichert …
                  </>
                ) : saveState === 'saved' ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-emerald-600" /> Formatierung gespeichert
                  </>
                ) : saveState === 'error' ? (
                  <span className="text-red-600">
                    Speichern fehlgeschlagen — wird erneut versucht
                  </span>
                ) : (
                  'Formatierung wird automatisch gespeichert.'
                )}
              </span>
            )}
          </div>
        )}
      </div>
    );
  },
);
