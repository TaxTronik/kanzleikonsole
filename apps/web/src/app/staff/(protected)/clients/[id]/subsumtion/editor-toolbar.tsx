'use client';

import type { KeyboardEvent, ReactNode } from 'react';
// =============================================================================
// Gemeinsame Format-Toolbar (Tiptap v3) — genutzt vom Sachverhalt-Editor
// (Compose) und vom formatierten Review (Formatierung bearbeiten). v3 rendert
// nicht pro Transaktion neu → reaktive Button-Zustände via useEditorState.
// =============================================================================

import { useEditorState, type Editor } from '@tiptap/react';
import {
  Bold,
  Italic,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Undo2,
  Redo2,
  AlignJustify,
} from 'lucide-react';

function Btn({
  active,
  disabled,
  onClick,
  title,
  ariaLabel,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  ariaLabel?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={ariaLabel ?? title}
      aria-pressed={active === undefined ? undefined : active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} // Fokus im Editor halten
      onClick={(event) => {
        onClick();
        if (event.detail === 0) {
          const button = event.currentTarget;
          requestAnimationFrame(() => button.focus());
        }
      }}
      style={active ? { color: 'rgb(var(--text-on-brand))' } : undefined}
      className={
        'rounded p-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 [--tw-ring-color:rgb(var(--brand-focus))] [--tw-ring-offset-color:rgb(var(--surface-card))] disabled:opacity-40 ' +
        (active
          ? 'bg-brand-600 hover:bg-brand-600'
          : 'text-secondary hover:bg-gray-100 dark:hover:bg-gray-800')
      }
    >
      {children}
    </button>
  );
}

function handleToolbarKeyDown(event: KeyboardEvent<HTMLDivElement>) {
  if (
    !(event.target instanceof HTMLButtonElement) ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey
  ) {
    return;
  }
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;

  const buttons = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
  );
  const currentIndex = buttons.indexOf(event.target);
  if (currentIndex === -1 || buttons.length === 0) return;

  event.preventDefault();
  const nextIndex =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
  buttons[nextIndex]?.focus();
}

/** Formatier-Buttons für einen Tiptap-Editor. `onReflow` (optional) blendet den
 *  „Absätze zusammenführen"-Button ein — nur im Compose sinnvoll, da er den
 *  Plaintext verändert (im Review-Format-Modus darf der Text unverändert bleiben).
 *  `bordered={false}` lässt den unteren Rand weg (für die schwebende Flyover-Leiste). */
export function FormatToolbar({
  editor,
  onReflow,
  bordered = true,
}: {
  editor: Editor;
  onReflow?: () => void;
  bordered?: boolean;
}) {
  const s = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor.isActive('bold'),
      italic: editor.isActive('italic'),
      h2: editor.isActive('heading', { level: 2 }),
      h3: editor.isActive('heading', { level: 3 }),
      bullet: editor.isActive('bulletList'),
      ordered: editor.isActive('orderedList'),
      canUndo: editor.can().undo(),
      canRedo: editor.can().redo(),
    }),
  });

  return (
    <div
      role="toolbar"
      aria-label={bordered ? 'Text formatieren' : 'Schwebende Textformatierung'}
      aria-orientation="horizontal"
      onKeyDown={handleToolbarKeyDown}
      className={
        'flex items-center gap-0.5 p-1 flex-wrap' + (bordered ? ' border-b border-default' : '')
      }
    >
      <Btn active={s?.bold} onClick={() => editor.chain().focus().toggleBold().run()} title="Fett">
        <Bold className="h-4 w-4" aria-hidden="true" />
      </Btn>
      <Btn
        active={s?.italic}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        title="Kursiv"
      >
        <Italic className="h-4 w-4" aria-hidden="true" />
      </Btn>
      <span aria-hidden="true" className="mx-1 h-5 w-px bg-border-subtle" />
      <Btn
        active={s?.h2}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        title="Überschrift"
      >
        <Heading2 className="h-4 w-4" aria-hidden="true" />
      </Btn>
      <Btn
        active={s?.h3}
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        title="Unter-Überschrift"
      >
        <Heading3 className="h-4 w-4" aria-hidden="true" />
      </Btn>
      <Btn
        active={s?.bullet}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        title="Aufzählung"
      >
        <List className="h-4 w-4" aria-hidden="true" />
      </Btn>
      <Btn
        active={s?.ordered}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        title="Nummerierte Liste"
      >
        <ListOrdered className="h-4 w-4" aria-hidden="true" />
      </Btn>
      {onReflow && (
        <>
          <span aria-hidden="true" className="mx-1 h-5 w-px bg-border-subtle" />
          <Btn
            onClick={onReflow}
            title="Absätze zusammenführen — harte Zeilenumbrüche zu Fließtext glätten (gegen Import-Fragmentierung)"
            ariaLabel="Absätze zusammenführen"
          >
            <AlignJustify className="h-4 w-4" aria-hidden="true" />
          </Btn>
        </>
      )}
      <span aria-hidden="true" className="ml-auto" />
      <Btn
        disabled={!s?.canUndo}
        onClick={() => editor.chain().focus().undo().run()}
        title="Rückgängig"
      >
        <Undo2 className="h-4 w-4" aria-hidden="true" />
      </Btn>
      <Btn
        disabled={!s?.canRedo}
        onClick={() => editor.chain().focus().redo().run()}
        title="Wiederholen"
      >
        <Redo2 className="h-4 w-4" aria-hidden="true" />
      </Btn>
    </div>
  );
}
