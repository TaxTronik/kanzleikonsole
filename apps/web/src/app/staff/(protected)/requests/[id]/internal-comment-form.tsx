'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { addRequestInternalCommentAction } from '../../clients/[id]/requests/actions';

export function InternalCommentForm({ requestId }: { requestId: string }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <form
      ref={formRef}
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        setError(null);
        startTransition(async () => {
          const result = await addRequestInternalCommentAction(data);
          if (!result.ok) {
            setError(result.error ?? 'Interner Kommentar konnte nicht gespeichert werden.');
            return;
          }
          formRef.current?.reset();
          router.refresh();
        });
      }}
    >
      <input type="hidden" name="requestId" value={requestId} />
      <textarea
        name="body"
        rows={3}
        className="input"
        placeholder="Interne Notiz für die Kanzlei…"
        required
        minLength={1}
        maxLength={5000}
      />
      {error && <div className="alert-error-sm">{error}</div>}
      <button type="submit" className="btn-secondary" disabled={isPending}>
        {isPending ? 'Speichert…' : 'Interne Notiz speichern'}
      </button>
    </form>
  );
}
