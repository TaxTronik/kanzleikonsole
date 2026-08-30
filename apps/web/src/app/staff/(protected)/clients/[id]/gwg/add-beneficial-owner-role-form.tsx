'use client';

import { useActionState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { BadgePercent } from 'lucide-react';
import { addBeneficialOwnerRoleAction } from './owner-actions';
import type { ActionResult } from './actions';
import { useGwgEditState } from './edit-state-context';

export function AddBeneficialOwnerRoleForm({
  checkId,
  clientId,
  representativeId,
  personName,
}: {
  checkId: string;
  clientId: string;
  representativeId: string;
  personName: string;
}) {
  const router = useRouter();
  const { markDraft, markRiskInvalidated } = useGwgEditState();
  const [state, action, pending] = useActionState<
    (ActionResult & { createdOwnerId?: string; reviewReset?: boolean }) | null,
    FormData
  >(addBeneficialOwnerRoleAction, null);

  useEffect(() => {
    if (!state?.ok || !state.createdOwnerId) return;
    if (state.reviewReset) markDraft();
    markRiskInvalidated();
    router.refresh();
  }, [markDraft, markRiskInvalidated, router, state]);

  return (
    <form
      action={action}
      className="max-w-2xl space-y-4 rounded-lg border border-default bg-surface-raised p-4"
    >
      <input type="hidden" name="checkId" value={checkId} />
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="representativeId" value={representativeId} />

      <div className="flex items-start gap-3">
        <span className="rounded-md border border-default bg-surface p-2 text-brand-600 dark:text-brand-300">
          <BadgePercent className="h-4 w-4" aria-hidden="true" />
        </span>
        <div>
          <p className="text-sm font-semibold text-primary">
            Wirtschaftlich berechtigte Rolle für {personName}
          </p>
          <p className="mt-1 text-xs text-secondary">
            Die allgemeinen Angaben werden aus der Person übernommen. Hier fehlt nur noch der
            rollenspezifische Anteil.
          </p>
        </div>
      </div>

      <div className="max-w-xs rounded-md border border-default bg-surface p-3">
        <label className="label-sm" htmlFor={`owner-role-ownership-${representativeId}`}>
          Anteil (%)
        </label>
        <input
          id={`owner-role-ownership-${representativeId}`}
          name="ownershipPct"
          type="number"
          className="input"
          step="0.01"
          min="0"
          max="100"
          disabled={pending}
        />
      </div>

      {state?.error && <div className="alert-error-sm">{state.error}</div>}
      <button type="submit" className="btn-primary text-xs" disabled={pending}>
        {pending ? 'Speichert…' : 'Doppelrolle speichern'}
      </button>
    </form>
  );
}
