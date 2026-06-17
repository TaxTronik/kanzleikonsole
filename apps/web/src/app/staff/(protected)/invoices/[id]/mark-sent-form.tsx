'use client';

import { useActionState } from 'react';
import { Send } from 'lucide-react';
import { markSentAction, type ActionResult } from '../actions';

export function MarkSentForm({ invoiceId }: { invoiceId: string }) {
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    markSentAction,
    null,
  );

  return (
    <form action={formAction}>
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <button type="submit" disabled={isPending} className="btn-primary disabled:opacity-60">
        <Send className="h-4 w-4" />
        {isPending ? 'Übergebe …' : 'An Mandant übergeben'}
      </button>
      {state && !state.ok && (
        <p className="mt-2 text-xs text-red-700 dark:text-red-400">{state.error}</p>
      )}
    </form>
  );
}
