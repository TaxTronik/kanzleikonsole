'use client';

import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { FileText, ImagePlus, Paperclip } from 'lucide-react';
import { RichMarkdownEditor, type RichMarkdownEditorHandle } from './rich-markdown-editor';

interface KnowledgeAttachment {
  id: string;
  displayName: string;
  mimeType: string;
}

interface Props {
  action: (formData: FormData) => Promise<void>;
  categories: Array<{ id: string; name: string }>;
  draftToken: string;
  initial?: {
    id: string;
    title: string;
    body: string;
    categoryId: string;
    published: boolean;
    attachments: KnowledgeAttachment[];
  };
}

type UploadMode = 'image' | 'file';

const attachmentUrl = (id: string): string => `/api/staff/knowledge/attachments/${id}`;

function markdownLabel(displayName: string): string {
  return displayName.replace(/[[\]\\]/g, '').trim() || 'Anhang';
}

function uploadErrorMessage(code: string | undefined, status: number): string {
  if (code === 'TOO_LARGE') return 'Die Datei ist zu groß.';
  if (code?.startsWith('INFECTED')) return 'Die Datei wurde vom Virenscanner abgelehnt.';
  if (code?.startsWith('SCAN_ERROR')) return 'Der Virenscanner ist derzeit nicht erreichbar.';
  if (code === 'upload_commit_failed') {
    return 'Der Anhang konnte nicht mit dem Artikel verknüpft werden. Bitte erneut versuchen.';
  }
  if (status === 403) return 'Für diesen Upload fehlt die Berechtigung.';
  return `Upload fehlgeschlagen (${status}).`;
}

export function ArticleEditor({ action, categories, draftToken, initial }: Props) {
  const [body, setBody] = useState(initial?.body ?? '');
  const [attachments, setAttachments] = useState<KnowledgeAttachment[]>(initial?.attachments ?? []);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const composerRef = useRef<RichMarkdownEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadModeRef = useRef<UploadMode>('file');

  function insertAttachment(attachment: KnowledgeAttachment, forceImage?: boolean) {
    const image = forceImage ?? attachment.mimeType.startsWith('image/');
    const label = markdownLabel(attachment.displayName);
    const url = attachmentUrl(attachment.id);
    const markdown = image ? `\n![${label}](${url})\n` : `\n[${label}](${url}?download=1)\n`;
    composerRef.current?.insertMarkdown(markdown);
  }

  function chooseUpload(mode: UploadMode) {
    uploadModeRef.current = mode;
    const input = fileInputRef.current;
    if (!input) return;
    input.accept = mode === 'image' ? 'image/png,image/jpeg,image/gif,image/webp' : '';
    input.click();
  }

  async function uploadAttachment(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (uploadModeRef.current === 'image' && !file.type.startsWith('image/')) {
      setUploadError('Bitte eine Bilddatei auswählen.');
      return;
    }

    setUploading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.set('file', file);
      formData.set('draftToken', draftToken);
      formData.set('displayName', file.name);
      formData.set('mimeType', file.type || 'application/octet-stream');
      if (initial?.id) formData.set('articleId', initial.id);
      const response = await fetch('/api/staff/knowledge/attachments', {
        method: 'POST',
        body: formData,
      });
      const result = (await response.json().catch(() => ({}))) as {
        error?: string;
        attachment?: KnowledgeAttachment;
      };
      if (!response.ok || !result.attachment) {
        throw new Error(uploadErrorMessage(result.error, response.status));
      }
      setAttachments((current) => [...current, result.attachment!]);
      insertAttachment(result.attachment, uploadModeRef.current === 'image');
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'Upload fehlgeschlagen.');
    } finally {
      setUploading(false);
    }
  }

  function validateContent(event: FormEvent<HTMLFormElement>) {
    if (body.trim()) {
      setContentError(null);
      return;
    }
    event.preventDefault();
    setContentError('Bitte einen Artikelinhalt erfassen.');
  }

  return (
    <form action={action} className="card overflow-hidden" onSubmit={validateContent}>
      {initial && <input type="hidden" name="id" value={initial.id} />}
      <input type="hidden" name="body" value={body} />
      <input type="hidden" name="attachmentDraftToken" value={draftToken} />
      <input
        type="hidden"
        name="attachmentIds"
        value={JSON.stringify(attachments.map((attachment) => attachment.id))}
      />
      <input
        ref={fileInputRef}
        type="file"
        className="sr-only"
        onChange={uploadAttachment}
        aria-label="Artikelanhang auswählen"
      />

      <div className="grid gap-4 border-b border-default p-6 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
        <div>
          <label className="label" htmlFor="title">
            Titel
          </label>
          <input
            id="title"
            name="title"
            type="text"
            className="input text-lg font-semibold"
            required
            minLength={1}
            maxLength={300}
            defaultValue={initial?.title ?? ''}
            placeholder="Worum geht es in diesem Artikel?"
          />
        </div>
        <div>
          <label className="label" htmlFor="categoryId">
            Kategorie
          </label>
          <select
            id="categoryId"
            name="categoryId"
            className="input"
            defaultValue={initial?.categoryId ?? ''}
          >
            <option value="">— Ohne Kategorie —</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {(uploadError || contentError) && (
        <div className="mx-6 mt-4 alert-error-sm">{uploadError ?? contentError}</div>
      )}

      <RichMarkdownEditor
        ref={composerRef}
        value={body}
        onChange={(markdown) => {
          setBody(markdown);
          if (markdown.trim()) setContentError(null);
        }}
        onChooseUpload={chooseUpload}
        uploading={uploading}
      />

      {attachments.length > 0 && (
        <section className="border-t border-default bg-gray-50/50 px-6 py-4">
          <div className="mb-3 flex items-center gap-2">
            <Paperclip className="h-4 w-4 text-muted" />
            <h2 className="text-sm font-semibold text-primary">Anhänge ({attachments.length})</h2>
          </div>
          <div className="flex flex-wrap gap-2">
            {attachments.map((attachment) => {
              const image = attachment.mimeType.startsWith('image/');
              return (
                <div
                  key={attachment.id}
                  className="inline-flex items-center gap-2 rounded-md border border-default bg-surface px-3 py-2 text-xs"
                >
                  {image ? (
                    <ImagePlus className="h-4 w-4 text-blue-600" />
                  ) : (
                    <FileText className="h-4 w-4 text-violet-600" />
                  )}
                  <span className="max-w-64 truncate text-secondary">{attachment.displayName}</span>
                  <button
                    type="button"
                    className="text-brand-700 hover:underline"
                    onClick={() => insertAttachment(attachment)}
                  >
                    Im Text einfügen
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-default bg-surface px-6 py-4">
        <label className="flex items-center gap-2 text-sm text-secondary">
          <input
            type="checkbox"
            name="published"
            value="1"
            defaultChecked={initial?.published ?? true}
          />
          Veröffentlicht (für alle Mitarbeiter sichtbar)
        </label>
        <button type="submit" className="btn-primary" disabled={uploading}>
          {initial ? 'Artikel speichern' : 'Artikel anlegen'}
        </button>
      </div>
    </form>
  );
}
