'use client';

import {
  forwardRef,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import {
  Bold,
  Code2,
  FileCode2,
  FileText,
  Highlighter,
  ImagePlus,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Palette,
  Quote,
  Redo2,
  RemoveFormatting,
  Strikethrough,
  Underline,
  Undo2,
} from 'lucide-react';
import { knowledgeEditorExtensions } from './knowledge-editor-extensions';
import { promptDialog } from '@/components/ui/modal';

export interface RichMarkdownEditorHandle {
  insertMarkdown: (markdown: string) => void;
}

interface Props {
  value: string;
  onChange: (markdown: string) => void;
  onChooseUpload: (mode: 'image' | 'file') => void;
  uploading: boolean;
}

function safeColorValue(value: string | undefined, fallback: string): string {
  return value?.match(/^#[0-9a-f]{6}$/i) ? value : fallback;
}

function ToolButton({
  active,
  disabled,
  onClick,
  title,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active === undefined ? undefined : active}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        onClick();
        if (event.detail === 0) {
          const button = event.currentTarget;
          requestAnimationFrame(() => button.focus());
        }
      }}
      style={active ? { color: 'rgb(var(--text-on-brand))' } : undefined}
      className={`rounded-md p-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 [--tw-ring-color:rgb(var(--brand-focus))] [--tw-ring-offset-color:rgb(var(--surface-card))] disabled:opacity-40 ${
        active
          ? 'bg-brand-600 hover:bg-brand-600'
          : 'text-secondary hover:bg-gray-100 hover:text-primary'
      }`}
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

  const controls = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not(:disabled), select:not(:disabled), input:not(:disabled)',
    ),
  );
  const currentIndex = controls.indexOf(event.target);
  if (currentIndex === -1 || controls.length === 0) return;

  event.preventDefault();
  const nextIndex =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? controls.length - 1
        : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + controls.length) %
          controls.length;
  controls[nextIndex]?.focus();
}

function RichToolbar({ editor }: { editor: Editor }) {
  const state = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor.isActive('bold'),
      italic: editor.isActive('italic'),
      underline: editor.isActive('underline'),
      strike: editor.isActive('strike'),
      bullet: editor.isActive('bulletList'),
      ordered: editor.isActive('orderedList'),
      quote: editor.isActive('blockquote'),
      code: editor.isActive('code'),
      heading: editor.isActive('heading', { level: 1 })
        ? '1'
        : editor.isActive('heading', { level: 2 })
          ? '2'
          : editor.isActive('heading', { level: 3 })
            ? '3'
            : '0',
      color: editor.getAttributes('textStyle').color as string | undefined,
      backgroundColor: editor.getAttributes('textStyle').backgroundColor as string | undefined,
      fontSize: editor.getAttributes('textStyle').fontSize as string | undefined,
      canUndo: editor.can().undo(),
      canRedo: editor.can().redo(),
    }),
  });

  function setHeading(value: string) {
    const chain = editor.chain().focus();
    if (value === '0') chain.setParagraph().run();
    else chain.setHeading({ level: Number(value) as 1 | 2 | 3 }).run();
  }

  async function setLink() {
    const current = editor.getAttributes('link').href as string | undefined;
    const href = await promptDialog('Linkziel', {
      title: 'Link bearbeiten',
      initialValue: current ?? 'https://',
      placeholder: 'https://…',
      maxLength: 2048,
    });
    if (href === null) return;
    if (!href.trim()) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: href.trim() }).run();
  }

  return (
    <div
      role="toolbar"
      aria-label="Artikeltext formatieren"
      aria-orientation="horizontal"
      onKeyDown={handleToolbarKeyDown}
      className="flex flex-wrap items-center gap-1 border-b border-default bg-surface px-3 py-2"
    >
      <select
        className="input w-36 py-1.5 text-xs"
        value={state?.heading ?? '0'}
        onChange={(event) => setHeading(event.target.value)}
        aria-label="Absatzformat"
        title="Absatzformat"
      >
        <option value="0">Normaler Text</option>
        <option value="1">Überschrift 1</option>
        <option value="2">Überschrift 2</option>
        <option value="3">Überschrift 3</option>
      </select>

      <ToolButton
        active={state?.bold}
        onClick={() => editor.chain().focus().toggleBold().run()}
        title="Fett"
      >
        <Bold className="h-4 w-4" aria-hidden="true" />
      </ToolButton>
      <ToolButton
        active={state?.italic}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        title="Kursiv"
      >
        <Italic className="h-4 w-4" aria-hidden="true" />
      </ToolButton>
      <ToolButton
        active={state?.underline}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        title="Unterstrichen"
      >
        <Underline className="h-4 w-4" aria-hidden="true" />
      </ToolButton>
      <ToolButton
        active={state?.strike}
        onClick={() => editor.chain().focus().toggleStrike().run()}
        title="Durchgestrichen"
      >
        <Strikethrough className="h-4 w-4" aria-hidden="true" />
      </ToolButton>
      <ToolButton active={editor.isActive('link')} onClick={setLink} title="Link">
        <LinkIcon className="h-4 w-4" aria-hidden="true" />
      </ToolButton>

      <span aria-hidden="true" className="mx-1 h-5 w-px bg-border-subtle" />
      <ToolButton
        active={state?.bullet}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        title="Aufzählung"
      >
        <List className="h-4 w-4" aria-hidden="true" />
      </ToolButton>
      <ToolButton
        active={state?.ordered}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        title="Nummerierte Liste"
      >
        <ListOrdered className="h-4 w-4" aria-hidden="true" />
      </ToolButton>
      <ToolButton
        active={state?.quote}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        title="Zitat"
      >
        <Quote className="h-4 w-4" aria-hidden="true" />
      </ToolButton>
      <ToolButton
        active={state?.code}
        onClick={() => editor.chain().focus().toggleCode().run()}
        title="Inline-Code"
      >
        <Code2 className="h-4 w-4" aria-hidden="true" />
      </ToolButton>

      <span aria-hidden="true" className="mx-1 h-5 w-px bg-border-subtle" />
      <label
        className="inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-secondary hover:bg-gray-100"
        title="Textfarbe"
      >
        <Palette className="h-4 w-4" aria-hidden="true" />
        <input
          type="color"
          value={safeColorValue(state?.color, '#1f2937')}
          onChange={(event) => editor.chain().focus().setColor(event.target.value).run()}
          className="h-5 w-5 cursor-pointer border-0 bg-transparent p-0"
          aria-label="Textfarbe"
        />
      </label>
      <label
        className="inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-secondary hover:bg-gray-100"
        title="Markerfarbe"
      >
        <Highlighter className="h-4 w-4" aria-hidden="true" />
        <input
          type="color"
          value={safeColorValue(state?.backgroundColor, '#fef08a')}
          onChange={(event) => editor.chain().focus().setBackgroundColor(event.target.value).run()}
          className="h-5 w-5 cursor-pointer border-0 bg-transparent p-0"
          aria-label="Markerfarbe"
        />
      </label>
      <select
        className="input w-24 py-1.5 text-xs"
        value={state?.fontSize ?? ''}
        onChange={(event) => {
          const value = event.target.value;
          if (value) editor.chain().focus().setFontSize(value).run();
          else editor.chain().focus().unsetFontSize().run();
        }}
        aria-label="Schriftgröße"
        title="Schriftgröße"
      >
        <option value="">Standard</option>
        <option value="0.875rem">Klein</option>
        <option value="1.125rem">Groß</option>
        <option value="1.25rem">Größer</option>
        <option value="1.5rem">Sehr groß</option>
      </select>
      <ToolButton
        onClick={() =>
          editor
            .chain()
            .focus()
            .unsetColor()
            .unsetBackgroundColor()
            .unsetFontSize()
            .unsetAllMarks()
            .run()
        }
        title="Formatierung entfernen"
      >
        <RemoveFormatting className="h-4 w-4" aria-hidden="true" />
      </ToolButton>

      <span aria-hidden="true" className="ml-auto" />
      <ToolButton
        disabled={!state?.canUndo}
        onClick={() => editor.chain().focus().undo().run()}
        title="Rückgängig"
      >
        <Undo2 className="h-4 w-4" aria-hidden="true" />
      </ToolButton>
      <ToolButton
        disabled={!state?.canRedo}
        onClick={() => editor.chain().focus().redo().run()}
        title="Wiederholen"
      >
        <Redo2 className="h-4 w-4" aria-hidden="true" />
      </ToolButton>
    </div>
  );
}

export const RichMarkdownEditor = forwardRef<RichMarkdownEditorHandle, Props>(
  function RichMarkdownEditor({ value, onChange, onChooseUpload, uploading }, ref) {
    const [mode, setMode] = useState<'inline' | 'source'>('inline');
    const sourceRef = useRef<HTMLTextAreaElement>(null);
    const inlinePanelId = useId();
    const sourcePanelId = useId();
    const modeStatusId = useId();
    const uploadStatusId = useId();
    const editor = useEditor({
      extensions: knowledgeEditorExtensions,
      content: value,
      contentType: 'markdown',
      immediatelyRender: false,
      editorProps: {
        attributes: {
          class:
            'min-h-[64vh] p-8 text-[15px] leading-7 text-primary outline-none ' +
            '[&_h1]:mb-4 [&_h1]:mt-8 [&_h1]:text-3xl [&_h1]:font-bold ' +
            '[&_h2]:mb-3 [&_h2]:mt-7 [&_h2]:text-2xl [&_h2]:font-semibold ' +
            '[&_h3]:mb-2 [&_h3]:mt-6 [&_h3]:text-xl [&_h3]:font-semibold ' +
            '[&_p]:my-3 [&_ul]:my-3 [&_ul]:ml-6 [&_ul]:list-disc ' +
            '[&_ol]:my-3 [&_ol]:ml-6 [&_ol]:list-decimal [&_blockquote]:my-4 ' +
            '[&_blockquote]:border-l-4 [&_blockquote]:border-strong [&_blockquote]:pl-4 ' +
            '[&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-gray-100 [&_pre]:p-4 ' +
            '[&_img]:my-6 [&_img]:max-h-[38rem] [&_img]:max-w-full [&_img]:rounded-lg ' +
            '[&_img]:border [&_img]:border-default [&_img]:object-contain',
          'aria-label': 'Artikelinhalt direkt formatiert bearbeiten',
          role: 'textbox',
          'aria-multiline': 'true',
        },
      },
      onUpdate: ({ editor }) => onChange(editor.getMarkdown()),
    });

    useImperativeHandle(
      ref,
      () => ({
        insertMarkdown(markdown: string) {
          if (mode === 'inline' && editor) {
            editor.commands.insertContent(markdown, { contentType: 'markdown' });
            editor.commands.focus();
            return;
          }
          const textarea = sourceRef.current;
          const start = textarea?.selectionStart ?? value.length;
          const end = textarea?.selectionEnd ?? value.length;
          const next = `${value.slice(0, start)}${markdown}${value.slice(end)}`;
          onChange(next);
          requestAnimationFrame(() => {
            sourceRef.current?.focus();
            const cursor = start + markdown.length;
            sourceRef.current?.setSelectionRange(cursor, cursor);
          });
        },
      }),
      [editor, mode, onChange, value],
    );

    function switchMode(nextMode: 'inline' | 'source') {
      if (nextMode === mode) return;
      if (nextMode === 'source' && editor) onChange(editor.getMarkdown());
      if (nextMode === 'inline' && editor) {
        editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false });
      }
      setMode(nextMode);
    }

    return (
      <div className="min-h-[64vh]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-default bg-gray-50/70 px-4 py-2">
          <div
            role="group"
            aria-label="Bearbeitungsansicht"
            aria-describedby={modeStatusId}
            className="flex items-center rounded-md border border-default bg-surface p-0.5"
          >
            <button
              type="button"
              aria-pressed={mode === 'inline'}
              aria-controls={mode === 'inline' ? inlinePanelId : undefined}
              style={mode === 'inline' ? { color: 'rgb(var(--text-on-brand))' } : undefined}
              className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 [--tw-ring-color:rgb(var(--brand-focus))] [--tw-ring-offset-color:rgb(var(--surface-card))] ${
                mode === 'inline' ? 'bg-brand-600' : 'text-muted hover:bg-gray-100'
              }`}
              onClick={() => switchMode('inline')}
            >
              <FileText className="h-3.5 w-3.5" aria-hidden="true" /> Inline
            </button>
            <button
              type="button"
              aria-pressed={mode === 'source'}
              aria-controls={mode === 'source' ? sourcePanelId : undefined}
              style={mode === 'source' ? { color: 'rgb(var(--text-on-brand))' } : undefined}
              className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 [--tw-ring-color:rgb(var(--brand-focus))] [--tw-ring-offset-color:rgb(var(--surface-card))] ${
                mode === 'source' ? 'bg-brand-600' : 'text-muted hover:bg-gray-100'
              }`}
              onClick={() => switchMode('source')}
            >
              <FileCode2 className="h-3.5 w-3.5" aria-hidden="true" /> Markdown
            </button>
          </div>
          <span id={modeStatusId} className="sr-only" role="status" aria-live="polite">
            {mode === 'inline' ? 'Inline-Ansicht ist aktiv.' : 'Markdown-Quellansicht ist aktiv.'}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium text-secondary hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 [--tw-ring-color:rgb(var(--brand-focus))] [--tw-ring-offset-color:rgb(var(--surface-card))]"
              onClick={() => onChooseUpload('image')}
              disabled={uploading}
              aria-describedby={uploading ? uploadStatusId : undefined}
            >
              <ImagePlus className="h-4 w-4" aria-hidden="true" /> Bild
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium text-secondary hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 [--tw-ring-color:rgb(var(--brand-focus))] [--tw-ring-offset-color:rgb(var(--surface-card))]"
              onClick={() => onChooseUpload('file')}
              disabled={uploading}
              aria-describedby={uploading ? uploadStatusId : undefined}
            >
              <FileText className="h-4 w-4" aria-hidden="true" /> Datei
            </button>
            {uploading && (
              <span
                id={uploadStatusId}
                className="ml-2 text-xs text-muted"
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                Anhang wird hochgeladen…
              </span>
            )}
          </div>
        </div>

        {mode === 'inline' ? (
          editor ? (
            <div id={inlinePanelId}>
              <RichToolbar editor={editor} />
              <EditorContent editor={editor} />
            </div>
          ) : (
            <div
              id={inlinePanelId}
              className="min-h-[64vh] p-8 text-sm text-muted"
              role="status"
              aria-live="polite"
            >
              Editor lädt …
            </div>
          )
        ) : (
          <textarea
            id={sourcePanelId}
            ref={sourceRef}
            className="min-h-[64vh] w-full resize-y border-0 bg-surface p-8 font-mono text-[15px] leading-7 text-primary outline-none focus:ring-0"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            maxLength={100000}
            aria-label="Markdown-Quelltext"
            placeholder="# Überschrift\n\nMarkdown-Quelltext"
          />
        )}
      </div>
    );
  },
);
