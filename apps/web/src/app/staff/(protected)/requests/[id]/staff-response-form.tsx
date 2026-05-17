'use client';

import { useState, useTransition, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { addStaffResponseAction } from '../../clients/[id]/requests/actions';

export function StaffResponseForm({ requestId }: { requestId: string }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <form
      ref={formRef}
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        setError(null);
        startTransition(async () => {
          const r = await addStaffResponseAction(fd);
          if (r.error) {
            setError(r.error);
          } else {
            formRef.current?.reset();
            router.refresh();
          }
        });
      }}
      className="space-y-3"
    >
      <input type="hidden" name="requestId" value={requestId} />
      <textarea
        name="message"
        rows={4}
        className="input"
        placeholder="Antwort an den Mandanten…"
        required
        minLength={1}
        maxLength={5000}
      />
      {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      <button type="submit" className="btn-primary" disabled={isPending}>
        {isPending ? 'Sendet…' : 'Antwort senden'}
      </button>
    </form>
  );
}
