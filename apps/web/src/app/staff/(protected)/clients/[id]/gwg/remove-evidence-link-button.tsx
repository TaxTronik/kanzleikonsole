'use client';

import { useActionState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, X } from 'lucide-react';
import { removeGwgEvidenceLinkAction } from './id-document-actions';
import type { ActionResult } from './actions';
import { confirmFormSubmission } from '@/components/ui/modal';

export function RemoveEvidenceLinkButton({
  checkId,
  clientId,
  gwgIdDocumentId,
}: {
  checkId: string;
  clientId: string;
  gwgIdDocumentId: string;
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState<
    (ActionResult & { reviewReset?: boolean }) | null,
    FormData
  >(removeGwgEvidenceLinkAction, null);

  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [router, state]);

  return (
    <form
      action={action}
      onSubmit={(event) =>
        confirmFormSubmission(
          event,
          'Nur die Zuordnung aus dieser GwG-Prüfung entfernen? Die Datei und ihre Versionen bleiben in der Mandantenakte erhalten.',
          {
            title: 'Nachweis-Zuordnung entfernen',
            confirmLabel: 'Zuordnung entfernen',
            danger: true,
          },
        )
      }
      className="ml-auto"
    >
      <input type="hidden" name="checkId" value={checkId} />
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="gwgIdDocumentId" value={gwgIdDocumentId} />
      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-red-50 hover:text-red-700 disabled:opacity-50 dark:hover:bg-red-950/30"
        aria-label="Falschen Upload aus der GwG-Prüfung entfernen"
        title="Zuordnung entfernen; Datei bleibt in der Mandantenakte"
      >
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
      </button>
      {state && !state.ok && (
        <p className="mt-1 max-w-64 text-right text-[11px] text-red-700">{state.error}</p>
      )}
    </form>
  );
}
