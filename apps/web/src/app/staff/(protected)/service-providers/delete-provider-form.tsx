'use client';

import { useActionState } from 'react';
import { Trash2 } from 'lucide-react';
import type { ActionResult } from '@/server/actions/types';
import { deleteServiceProviderAction } from './actions';

export function DeleteProviderForm({ id, name }: { id: string; name: string }) {
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    deleteServiceProviderAction,
    null,
  );

  return (
    <div className="flex max-w-xs flex-col items-end gap-1">
      <form action={formAction}>
        <input type="hidden" name="id" value={id} />
        <button
          type="submit"
          className="p-2 text-disabled hover:text-red-600 disabled:opacity-50"
          title={`${name} löschen`}
          aria-label={`${name} löschen`}
          disabled={isPending}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </form>
      {state && !state.ok && state.error && (
        <p role="alert" className="text-right text-xs text-red-700 dark:text-red-300">
          {state.error}
        </p>
      )}
    </div>
  );
}
