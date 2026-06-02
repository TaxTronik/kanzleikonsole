'use client';

// =============================================================================
// WYSIWYG-Editor (Tiptap v3) für den Sachverhalt im Compose-Modus.
//
// Rich-Text dient dem Erfassen/Aufräumen (besonders nach Doc-Import). Beim
// Analysieren wird zu REINEM Text serialisiert (`getText`, Absätze = \n\n) —
// die Engine + das Highlight-Overlay arbeiten auf Zeichen-Offsets im Plaintext.
// =============================================================================

import { forwardRef, useImperativeHandle, useCallback } from 'react';
import { useEditor, useEditorState, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Bold, Italic, Heading2, Heading3, List, ListOrdered, Undo2, Redo2, AlignJustify } from 'lucide-react';

export interface SachverhaltEditorHandle {
  setText: (text: string) => void;
  getText: () => string;
  focus: () => void;
}

const BLOCK_SEP = '\n\n';

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
    extensions: [StarterKit],
    content: initialText ? textToHtml(initialText) : '<p></p>',
    immediatelyRender: false, // SSR (Next App Router): erst client-seitig rendern.
    editorProps: {
      attributes: {
        class: 'tt-content min-h-[18rem] max-h-[60vh] overflow-y-auto px-3 py-2 text-sm leading-relaxed focus:outline-none',
      },
    },
    onUpdate: ({ editor }) => onChange(editor.getText({ blockSeparator: BLOCK_SEP })),
  });

  useImperativeHandle(
    ref,
    () => ({
      setText: (text: string) => {
        editor?.commands.setContent(textToHtml(text));
        if (editor) onChange(editor.getText({ blockSeparator: BLOCK_SEP }));
      },
      getText: () => editor?.getText({ blockSeparator: BLOCK_SEP }) ?? '',
      focus: () => editor?.commands.focus(),
    }),
    [editor, onChange],
  );

  // v3: kein Auto-Rerender pro Transaktion → reaktive Toolbar via useEditorState.
  const s = useEditorState({
    editor,
    selector: ({ editor }) =>
      editor
        ? {
            bold: editor.isActive('bold'),
            italic: editor.isActive('italic'),
            h2: editor.isActive('heading', { level: 2 }),
            h3: editor.isActive('heading', { level: 3 }),
            bullet: editor.isActive('bulletList'),
            ordered: editor.isActive('orderedList'),
            canUndo: editor.can().undo(),
            canRedo: editor.can().redo(),
          }
        : null,
  });

  /** Einzelne (harte) Zeilenumbrüche → Leerzeichen; Absätze (\n\n) bleiben.
   *  Bewusst berater-ausgelöst (im Deutschen ist Auto-Reflow unzuverlässig),
   *  mit Undo (Ctrl+Z) revidierbar. Gegen Import-Fragmentierung. */
  const reflow = useCallback(() => {
    if (!editor) return;
    const t = editor.getText({ blockSeparator: BLOCK_SEP });
    const joined = t.replace(/([^\n])\n([^\n])/g, '$1 $2');
    editor.commands.setContent(textToHtml(joined));
    onChange(editor.getText({ blockSeparator: BLOCK_SEP }));
  }, [editor, onChange]);

  if (!editor) {
    return <div className="rounded-md border border-default bg-surface p-3 text-sm text-muted">Editor lädt …</div>;
  }

  const Btn = ({ active, disabled, onClick, title, children }: { active?: boolean; disabled?: boolean; onClick: () => void; title: string; children: React.ReactNode }) => (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} // Fokus im Editor halten
      onClick={onClick}
      className={
        'rounded p-1.5 text-secondary hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40 ' +
        (active ? 'bg-brand-100 text-brand-700 dark:bg-brand-500/20' : '')
      }
    >
      {children}
    </button>
  );

  return (
    <div className="rounded-md border border-default bg-surface">
      <div className="flex items-center gap-0.5 border-b border-default p-1 flex-wrap">
        <Btn active={s?.bold} onClick={() => editor.chain().focus().toggleBold().run()} title="Fett"><Bold className="h-4 w-4" /></Btn>
        <Btn active={s?.italic} onClick={() => editor.chain().focus().toggleItalic().run()} title="Kursiv"><Italic className="h-4 w-4" /></Btn>
        <span className="mx-1 h-5 w-px bg-border-subtle" />
        <Btn active={s?.h2} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} title="Überschrift"><Heading2 className="h-4 w-4" /></Btn>
        <Btn active={s?.h3} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} title="Unter-Überschrift"><Heading3 className="h-4 w-4" /></Btn>
        <Btn active={s?.bullet} onClick={() => editor.chain().focus().toggleBulletList().run()} title="Aufzählung"><List className="h-4 w-4" /></Btn>
        <Btn active={s?.ordered} onClick={() => editor.chain().focus().toggleOrderedList().run()} title="Nummerierte Liste"><ListOrdered className="h-4 w-4" /></Btn>
        <span className="mx-1 h-5 w-px bg-border-subtle" />
        <Btn onClick={reflow} title="Absätze zusammenführen — harte Zeilenumbrüche zu Fließtext glätten (gegen Import-Fragmentierung)"><AlignJustify className="h-4 w-4" /></Btn>
        <span className="ml-auto" />
        <Btn disabled={!s?.canUndo} onClick={() => editor.chain().focus().undo().run()} title="Rückgängig"><Undo2 className="h-4 w-4" /></Btn>
        <Btn disabled={!s?.canRedo} onClick={() => editor.chain().focus().redo().run()} title="Wiederholen"><Redo2 className="h-4 w-4" /></Btn>
      </div>
      <EditorContent editor={editor} />
    </div>
  );
});
