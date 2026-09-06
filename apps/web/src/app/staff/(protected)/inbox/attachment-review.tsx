'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { FormErrorSummary } from '@/components/form-errors';
import type { ActionResult } from '@/server/actions/types';
import { acceptInboxAttachmentAction, rejectInboxAttachmentAction } from './actions';

export function InboxAttachmentReview({
  attachmentId,
  defaultTitle,
  documentTypes,
}: {
  attachmentId: string;
  defaultTitle: string;
  documentTypes: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [state, setState] = useState<ActionResult>({ ok: true });
  const [busy, setBusy] = useState(false);

  async function accept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await acceptInboxAttachmentAction(new FormData(event.currentTarget));
      setState(result);
      if (result.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function reject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await rejectInboxAttachmentAction(new FormData(event.currentTarget));
      setState(result);
      if (result.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 space-y-3 border-t border-border-subtle pt-3">
      <FormErrorSummary
        error={state.ok ? undefined : state.error}
        fieldErrors={state.fieldErrors}
      />
      <form
        onSubmit={accept}
        className="grid gap-2 sm:grid-cols-[minmax(12rem,1fr)_minmax(12rem,1fr)_auto] sm:items-end"
      >
        <input type="hidden" name="attachmentId" value={attachmentId} />
        <label className="text-sm">
          <span className="label">Dokumenttitel</span>
          <input
            className="input w-full"
            name="title"
            defaultValue={defaultTitle}
            required
            maxLength={160}
          />
        </label>
        <label className="text-sm">
          <span className="label">Aktiver Dokumenttyp</span>
          <select className="input w-full" name="documentTypeId" required defaultValue="">
            <option value="">Auswählen</option>
            {documentTypes.map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </select>
        </label>
        <button className="btn-primary" disabled={busy}>
          Übernehmen
        </button>
      </form>
      <form onSubmit={reject} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="attachmentId" value={attachmentId} />
        <label className="text-sm">
          <span className="label">Neutraler Ablehnungsgrund</span>
          <select className="input" name="reason" defaultValue="NOT_REQUIRED">
            <option value="NOT_REQUIRED">Nicht zur Übernahme vorgesehen</option>
            <option value="DUPLICATE">Bereits vorhanden</option>
            <option value="UNSUPPORTED">Nicht als Kanzleidokument übernehmbar</option>
            <option value="OTHER">Sonstiger neutraler Grund</option>
          </select>
        </label>
        <button className="btn-secondary" disabled={busy}>
          Ablehnen
        </button>
      </form>
      <p className="text-xs text-muted">
        Keine automatische OCR, Indexierung, Frist-, Workflow- oder Anforderungsänderung.
      </p>
    </div>
  );
}
