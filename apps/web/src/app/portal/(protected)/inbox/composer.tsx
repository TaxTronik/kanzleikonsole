'use client';

import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { FieldError, FormErrorSummary, fieldErrorProps } from '@/components/form-errors';
import type { ActionResult } from '@/server/actions/types';
import {
  INBOX_MAX_ATTACHMENTS,
  INBOX_MAX_FILE_BYTES,
  INBOX_MAX_TOTAL_BYTES,
  INBOX_MESSAGE_MAX_LENGTH,
  INBOX_SUBJECT_MAX_LENGTH,
  INBOX_TOPIC_LABELS,
  INBOX_TOPICS,
} from '@/server/inbox/constants';
import {
  addInboxMessageAction,
  createInboxThreadAction,
  createInboxUploadBatchAction,
  discardInboxUploadBatchAction,
} from './actions';

type ComposerMode = { kind: 'new' } | { kind: 'reply'; threadId: string };

interface UploadFailure {
  error?: string;
  attachmentId?: string;
  retryable?: boolean;
}

const ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.tif,.tiff,.xml';

export function InboxComposer({
  mode,
  allowAttachments = true,
}: {
  mode: ComposerMode;
  allowAttachments?: boolean;
}) {
  const router = useRouter();
  const mutationId = useRef(crypto.randomUUID());
  const [result, setResult] = useState<ActionResult>({ ok: true });
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [batchId, setBatchId] = useState<string | null>(null);
  const uploadedIndexes = useRef(new Set<number>());
  const resumeIds = useRef(new Map<number, string>());

  async function discardDraft(): Promise<boolean> {
    if (!batchId) return true;
    const form = new FormData();
    form.set('id', batchId);
    const discarded = await discardInboxUploadBatchAction(form);
    if (!discarded.ok) {
      setResult(discarded);
      return false;
    }
    setBatchId(null);
    uploadedIndexes.current.clear();
    resumeIds.current.clear();
    setProgress('Uploadentwurf verworfen.');
    return true;
  }

  async function onFilesChanged(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    if (!(await discardDraft())) {
      event.target.value = '';
      return;
    }
    const selected = Array.from(event.target.files ?? []);
    const total = selected.reduce((sum, file) => sum + file.size, 0);
    if (
      selected.length > INBOX_MAX_ATTACHMENTS ||
      selected.some((file) => file.size > INBOX_MAX_FILE_BYTES) ||
      total > INBOX_MAX_TOTAL_BYTES
    ) {
      setFiles([]);
      event.target.value = '';
      setResult({
        ok: false,
        error: 'Maximal 10 Dateien, 25 MiB je Datei und 100 MiB insgesamt.',
        errorCode: 'VALIDATION_ERROR',
        fieldErrors: { files: ['Die ausgewählten Dateien überschreiten die Uploadgrenzen.'] },
      });
      return;
    }
    setFiles(selected);
    setResult({ ok: true });
  }

  async function ensureBatch(): Promise<string | null> {
    if (files.length === 0) return null;
    if (batchId) return batchId;
    const form = new FormData();
    form.set('purpose', mode.kind === 'new' ? 'NEW_THREAD' : 'REPLY');
    if (mode.kind === 'reply') form.set('targetThreadId', mode.threadId);
    const created = await createInboxUploadBatchAction(form);
    if (!created.ok || !created.batchId) {
      setResult(created);
      return null;
    }
    setBatchId(created.batchId);
    return created.batchId;
  }

  async function uploadFiles(activeBatchId: string): Promise<boolean> {
    for (let index = 0; index < files.length; index += 1) {
      if (uploadedIndexes.current.has(index)) continue;
      const file = files[index]!;
      setProgress(`Anlage ${index + 1} von ${files.length} wird sicher geprüft und übertragen.`);
      const body = new FormData();
      body.set('file', file);
      const resumeId = resumeIds.current.get(index);
      if (resumeId) body.set('resumeAttachmentId', resumeId);
      const response = await fetch(`/api/portal/inbox/batches/${activeBatchId}/files`, {
        method: 'POST',
        body,
      });
      const payload = (await response.json().catch(() => ({}))) as UploadFailure;
      if (!response.ok) {
        if (payload.retryable && payload.attachmentId) {
          resumeIds.current.set(index, payload.attachmentId);
        }
        setResult({
          ok: false,
          error:
            payload.error === 'file_blocked'
              ? 'Die Datei kann aus Sicherheitsgründen nicht angenommen werden.'
              : payload.error === 'scan_unavailable'
                ? 'Die Sicherheitsprüfung ist vorübergehend nicht verfügbar.'
                : 'Die Anlage konnte nicht vollständig übertragen werden. Sie können sicher erneut versuchen.',
          errorCode: 'CONFLICT',
          fieldErrors: { files: ['Upload nicht abgeschlossen.'] },
        });
        return false;
      }
      uploadedIndexes.current.add(index);
      resumeIds.current.delete(index);
    }
    setProgress(files.length ? 'Alle Anlagen wurden geprüft und sicher entgegengenommen.' : '');
    return true;
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setResult({ ok: true });
    try {
      const form = new FormData(event.currentTarget);
      form.set('clientMutationId', mutationId.current);
      const activeBatchId = await ensureBatch();
      if (files.length > 0 && !activeBatchId) return;
      if (activeBatchId && !(await uploadFiles(activeBatchId))) return;
      if (activeBatchId) form.set('batchId', activeBatchId);

      const saved =
        mode.kind === 'new'
          ? await createInboxThreadAction(form)
          : await addInboxMessageAction(form);
      setResult(saved);
      if (!saved.ok || !saved.threadId) return;

      setBatchId(null);
      uploadedIndexes.current.clear();
      resumeIds.current.clear();
      mutationId.current = crypto.randomUUID();
      setProgress('Nachricht technisch eingegangen.');
      router.push(`/portal/inbox/${saved.threadId}`);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      <FormErrorSummary
        error={result.ok ? undefined : result.error}
        fieldErrors={result.fieldErrors}
        fieldIds={{
          subject: 'inbox-subject',
          topic: 'inbox-topic',
          body: 'inbox-body',
          files: 'inbox-files',
        }}
      />

      {mode.kind === 'new' ? (
        <>
          <div>
            <label htmlFor="inbox-subject" className="label">
              Betreff
            </label>
            <input
              id="inbox-subject"
              name="subject"
              className="input w-full"
              required
              maxLength={INBOX_SUBJECT_MAX_LENGTH}
              {...fieldErrorProps('subject', result.fieldErrors)}
            />
            <FieldError name="subject" errors={result.fieldErrors?.subject} />
          </div>
          <div>
            <label htmlFor="inbox-topic" className="label">
              Thema
            </label>
            <select
              id="inbox-topic"
              name="topic"
              className="input w-full"
              defaultValue="GENERAL"
              {...fieldErrorProps('topic', result.fieldErrors)}
            >
              {INBOX_TOPICS.map((topic) => (
                <option key={topic} value={topic}>
                  {INBOX_TOPIC_LABELS[topic]}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-muted">
              Das Thema dient nur Filterung und Routing, nicht der Dokumentklassifikation.
            </p>
            <FieldError name="topic" errors={result.fieldErrors?.topic} />
          </div>
        </>
      ) : (
        <input type="hidden" name="threadId" value={mode.threadId} />
      )}

      <div>
        <label htmlFor="inbox-body" className="label">
          Nachricht
        </label>
        <textarea
          id="inbox-body"
          name="body"
          className="input min-h-36 w-full"
          required
          maxLength={INBOX_MESSAGE_MAX_LENGTH}
          {...fieldErrorProps('body', result.fieldErrors)}
        />
        <FieldError name="body" errors={result.fieldErrors?.body} />
      </div>

      {allowAttachments ? (
        <div>
          <label htmlFor="inbox-files" className="label">
            Anlagen (optional)
          </label>
          <input
            id="inbox-files"
            type="file"
            multiple
            accept={ACCEPT}
            className="input w-full"
            onChange={onFilesChanged}
            {...fieldErrorProps('files', result.fieldErrors)}
          />
          <p className="mt-1 text-xs text-muted">
            PDF, JPEG, PNG, WebP, TIFF oder XML; höchstens 10 Dateien, 25 MiB je Datei und 100 MiB
            insgesamt.
          </p>
          <FieldError name="files" errors={result.fieldErrors?.files} />
        </div>
      ) : (
        <p className="text-sm text-muted">Anlagen sind für dieses Portalprofil nicht aktiviert.</p>
      )}

      <div className="alert-warning text-sm">
        Nach dem Absenden sehen alle aktiven Portal-Kontakte dieses Mandanten die Nachricht und
        saubere Anlagen. Der technische Eingang erledigt keine Anforderung, setzt keine Frist und
        bedeutet noch keine fachliche Annahme.
      </div>
      <p aria-live="polite" className="text-sm text-muted">
        {progress}
      </p>

      <div className="flex flex-wrap gap-3">
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Wird gesendet …' : 'Nachricht senden'}
        </button>
        {batchId ? (
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() => void discardDraft()}
          >
            Uploadentwurf verwerfen
          </button>
        ) : null}
      </div>
    </form>
  );
}
