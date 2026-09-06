'use client';

import { useActionState, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { removeBeneficialOwnerAction, updateBeneficialOwnerAction } from './owner-actions';
import {
  type ActionResult,
  type InvalidatedIdentitySet,
  type SavedBeneficialOwner,
} from './actions';
import { useGwgIdentitySubjects } from './identity-subjects-context';
import { useGwgEditState } from './edit-state-context';
import { confirmFormSubmission } from '@/components/ui/modal';

type BeneficialOwnerFormValue = {
  fullName: string;
  birthDate: string;
  birthPlace: string;
  residence: string;
  nationality: string;
  ownershipPct: string;
  isPep: boolean;
};

export function BeneficialOwnerForm({
  ownerId,
  checkId,
  clientId,
  value,
  revision,
  defaultOpen = false,
}: {
  ownerId: string;
  checkId: string;
  clientId: string;
  value: BeneficialOwnerFormValue;
  revision: string;
  defaultOpen?: boolean;
}) {
  const router = useRouter();
  const { updateBeneficialOwner, removeBeneficialOwner, registerIdentityInvalidations } =
    useGwgIdentitySubjects();
  const { markDraft, markRiskInvalidated } = useGwgEditState();
  const [displayValue, setDisplayValue] = useState(value);
  const [draftValue, setDraftValue] = useState(value);
  const [currentRevision, setCurrentRevision] = useState(revision);
  const [state, action, pending] = useActionState<
    | (ActionResult & {
        reviewReset?: boolean;
        revision?: string;
        saved?: SavedBeneficialOwner;
        invalidatedIdentitySets?: InvalidatedIdentitySet[];
      })
    | null,
    FormData
  >(async (previous, data) => {
    const result = await updateBeneficialOwnerAction(previous, data);
    if (!result?.ok || !result.saved) return result;
    updateBeneficialOwner(result.saved);
    setDisplayValue(result.saved);
    setDraftValue(result.saved);
    if (result.revision) setCurrentRevision(result.revision);
    registerIdentityInvalidations(result.invalidatedIdentitySets ?? []);
    // Die Server-Action setzt die Risikobewertung zurück (invalidateRisk) —
    // das Risiko-Formular muss seine CAS-Revision sofort nachziehen.
    markRiskInvalidated();
    if (result.reviewReset) markDraft();
    router.refresh();
    return result;
  }, null);
  const [removeState, removeAction, removePending] = useActionState<
    | (ActionResult & {
        removedOwnerId?: string;
        reviewReset?: boolean;
        invalidatedIdentitySets?: InvalidatedIdentitySet[];
      })
    | null,
    FormData
  >(async (previous, data) => {
    const result = await removeBeneficialOwnerAction(previous, data);
    if (!result?.ok || !result.removedOwnerId) return result;
    removeBeneficialOwner(result.removedOwnerId);
    registerIdentityInvalidations(result.invalidatedIdentitySets ?? []);
    markRiskInvalidated();
    if (result.reviewReset) markDraft();
    router.refresh();
    return result;
  }, null);
  const id = (field: string) => `owner-${ownerId}-${field}`;

  if (removeState?.ok && removeState.removedOwnerId === ownerId) {
    return (
      <div className="alert-success-sm w-full">
        Die Person wurde aus dem aktuellen Prüfsnapshot entfernt. Frühere Prüfungen bleiben
        unverändert erhalten.
      </div>
    );
  }

  return (
    <div className="min-w-0 w-full">
      <p className="text-xs text-muted">
        Anteil:{' '}
        {displayValue.ownershipPct
          ? `${Number(displayValue.ownershipPct).toFixed(2)} %`
          : 'nicht beziffert'}
      </p>
      <details
        className="mt-3 rounded-md border border-default bg-subtle px-3 py-2"
        open={defaultOpen || undefined}
      >
        <summary className="cursor-pointer text-xs font-medium text-secondary">
          Angaben zur wirtschaftlichen Berechtigung
        </summary>
        <form action={action} className="mt-3 space-y-3">
          <input type="hidden" name="ownerId" value={ownerId} />
          <input type="hidden" name="checkId" value={checkId} />
          <input type="hidden" name="clientId" value={clientId} />
          <input type="hidden" name="expectedRevision" value={currentRevision} />
          <input type="hidden" name="fullName" value={draftValue.fullName} />
          <input type="hidden" name="birthDate" value={draftValue.birthDate} />
          <input type="hidden" name="birthPlace" value={draftValue.birthPlace} />
          <input type="hidden" name="nationality" value={draftValue.nationality} />
          <input type="hidden" name="residence" value={draftValue.residence} />
          <input type="hidden" name="isPep" value={draftValue.isPep ? 'true' : 'false'} />

          <div className="max-w-xs">
            <label className="label-sm" htmlFor={id('ownershipPct')}>
              Anteil (%)
            </label>
            <input
              id={id('ownershipPct')}
              name="ownershipPct"
              type="number"
              className="input"
              value={draftValue.ownershipPct}
              onChange={(event) =>
                setDraftValue((current) => ({ ...current, ownershipPct: event.target.value }))
              }
              step="0.01"
              min="0"
              max="100"
              disabled={pending || removePending}
            />
          </div>

          <p className="text-xs text-muted">
            Eine Änderung setzt eine bereits eingereichte Prüfung wieder auf Entwurf zurück.
          </p>
          {state?.error && <div className="alert-error-sm">{state.error}</div>}
          {state?.ok && (
            <p className="text-xs text-emerald-700">
              Gespeichert.
              {state.reviewReset
                ? ' Die laufende Prüfung wurde zur erneuten Freigabe zurückgesetzt.'
                : ''}
            </p>
          )}
          <button type="submit" className="btn-secondary text-xs" disabled={pending}>
            {pending ? 'Speichert…' : 'Rollendaten speichern'}
          </button>
        </form>
        <form
          action={removeAction}
          className="mt-3 border-t border-default pt-3"
          onSubmit={(event) =>
            confirmFormSubmission(
              event,
              `${displayValue.fullName} wirklich aus dem aktuellen Prüfsnapshot entfernen? Zugeordnete Ausweise müssen danach neu zugeordnet werden.`,
              {
                title: 'Wirtschaftlich Berechtigten entfernen',
                confirmLabel: 'Entfernen',
                danger: true,
              },
            )
          }
        >
          <input type="hidden" name="ownerId" value={ownerId} />
          <input type="hidden" name="checkId" value={checkId} />
          <input type="hidden" name="clientId" value={clientId} />
          <input type="hidden" name="expectedRevision" value={currentRevision} />
          {removeState?.error && <div className="alert-error-sm mb-2">{removeState.error}</div>}
          <button
            type="submit"
            className="btn-secondary text-xs text-red-700"
            disabled={removePending || pending}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {removePending ? 'Entfernt…' : 'Nicht mehr wirtschaftlich berechtigt'}
          </button>
        </form>
      </details>
    </div>
  );
}
