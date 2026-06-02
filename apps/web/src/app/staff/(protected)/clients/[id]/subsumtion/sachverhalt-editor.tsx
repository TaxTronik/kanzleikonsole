'use client';

// =============================================================================
// WYSIWYG-Editor (Tiptap v3) für den Sachverhalt im Compose-Modus.
//
// Rich-Text dient dem Erfassen/Aufräumen (besonders nach Doc-Import). Beim
// Analysieren wird zu REINEM Text serialisiert (`getText`, Absätze = \n\n) —
// die Engine + das Highlight-Overlay arbeiten auf Zeichen-Offsets im Plaintext.
// =============================================================================

import { forwardRef, useImperativeHandle, useCallback } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { docToText } from './doc-text';
import { baseEditorExtensions } from './editor-extensions';
import { FormatToolbar } from './editor-toolbar';

export interface SachverhaltEditorHandle {
  setText: (text: string) => void;
  getText: () => string;
  /** Formatierter Inhalt als Tiptap/ProseMirror-JSON (für sourceDoc). */
  getDoc: () => unknown;
  focus: () => void;
}

/** Plain text → HTML (Absätze aus Leerzeilen, <br> für einzelne Umbrüche). */
function textToHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const paras = text.split(/\n{2,}/);
  return paras.map((p) => '<p>' + (p ? esc(p).replace(/\n/g, '<br>') : '') + '</p>').join('') || '<p></p>';
}

interface Props {
  initialText?: string;
  onChange: (plainText: string) => void;
}

export const SachverhaltEditor = forwardRef<SachverhaltEditorHandle, Props>(function SachverhaltEditor(
  { initialText = '', onChange },
  ref,
) {
  const editor = useEditor({
    extensions: baseEditorExtensions,
    content: initialText ? textToHtml(initialText) : '<p></p>',
    immediatelyRender: false, // SSR (Next App Router): erst client-seitig rendern.
    editorProps: {
      attributes: {
        class: 'tt-content min-h-[18rem] max-h-[60vh] overflow-y-auto px-3 py-2 text-sm leading-relaxed focus:outline-none',
      },
    },
    // Plaintext über die GEMEINSAME Serialisierung (deckungsgleich mit dem
    // Review-Mapping) — nicht über getText.
    onUpdate: ({ editor }) => onChange(docToText(editor.state.doc).text),
  });

  useImperativeHandle(
    ref,
    () => ({
      setText: (text: string) => {
        editor?.commands.setContent(textToHtml(text));
        if (editor) onChange(docToText(editor.state.doc).text);
      },
      getText: () => (editor ? docToText(editor.state.doc).text : ''),
      getDoc: () => editor?.getJSON() ?? null,
      focus: () => editor?.commands.focus(),
    }),
    [editor, onChange],
  );

  /** Einzelne (harte) Zeilenumbrüche → Leerzeichen; Absätze (\n\n) bleiben.
   *  Bewusst berater-ausgelöst (im Deutschen ist Auto-Reflow unzuverlässig),
   *  mit Undo (Ctrl+Z) revidierbar. Gegen Import-Fragmentierung. */
  const reflow = useCallback(() => {
    if (!editor) return;
    const t = docToText(editor.state.doc).text;
    const joined = t.replace(/([^\n])\n([^\n])/g, '$1 $2');
    editor.commands.setContent(textToHtml(joined));
    onChange(docToText(editor.state.doc).text);
  }, [editor, onChange]);

  if (!editor) {
    return <div className="rounded-md border border-default bg-surface p-3 text-sm text-muted">Editor lädt …</div>;
  }

  return (
    <div className="rounded-md border border-default bg-surface">
      <FormatToolbar editor={editor} onReflow={reflow} />
      <EditorContent editor={editor} />
    </div>
  );
});
