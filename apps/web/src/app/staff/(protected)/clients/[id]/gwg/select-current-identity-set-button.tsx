'use client';

import { useActionState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2 } from 'lucide-react';
import { selectCurrentIdentityDocumentSetAction } from './id-document-actions';
import type { ActionResult } from './actions';
import { confirmFormSubmission } from '@/components/ui/modal';

export function SelectCurrentIdentitySetButton({
  checkId,
  clientId,
  documentSetId,
}: {
  checkId: string;
  clientId: string;
  documentSetId: string;
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState<
    (ActionResult & { reviewReset?: boolean }) | null,
    FormData
  >(selectCurrentIdentityDocumentSetAction, null);

  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [router, state]);

  return (
    <form
      action={action}
      onSubmit={(event) =>
        confirmFormSubmission(
          event,
          'Diesen Ausweissatz als aktuell festlegen? Alle anderen aktiven Ausweise dieser Person werden unter „Alte Ausweise“ abgelegt.',
          { title: 'Aktuellen Ausweissatz festlegen', confirmLabel: 'Festlegen' },
        )
      }
    >
      <input type="hidden" name="checkId" value={checkId} />
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="documentSetId" value={documentSetId} />
      <button type="submit" className="btn-secondary text-xs" disabled={pending}>
        {pending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Check className="h-3.5 w-3.5" />
        )}
        {pending ? 'Wird festgelegt …' : 'Diesen Ausweis als aktuell festlegen'}
      </button>
      {state && !state.ok && <p className="mt-2 text-xs text-red-700">{state.error}</p>}
    </form>
  );
}
