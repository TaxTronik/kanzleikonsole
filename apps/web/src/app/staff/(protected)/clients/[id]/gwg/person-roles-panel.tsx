'use client';

import { useActionState, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BadgeCheck, Pencil, X } from 'lucide-react';
import {
  saveLegalEntityDetailsAction,
  type ActionResult,
  type InvalidatedIdentitySet,
} from './actions';
import { BeneficialOwnerForm } from './beneficial-owner-form';
import { AddBeneficialOwnerRoleForm } from './add-beneficial-owner-role-form';
import { useGwgIdentitySubjects, type EditableRepresentative } from './identity-subjects-context';
import { useGwgEditState } from './edit-state-context';

interface OwnerValue {
  id: string;
  fullName: string;
  birthDate: string;
  birthPlace: string;
  residence: string;
  nationality: string;
  ownershipPct: string;
  isPep: boolean;
  revision: string;
}

interface Props {
  checkId: string;
  clientId: string;
  personName: string;
  roleLabels: string[];
  owner: OwnerValue | null;
  representativeId: string | null;
  current: {
    legalForm: string | null;
    registerNumber: string | null;
    registerAuthority: string | null;
    noRegisterEntry: boolean;
    representatives: EditableRepresentative[];
    ownershipStructureNotes: string | null;
  };
  currentRevision: string;
  disabled: boolean;
}

export function PersonRolesPanel({
  checkId,
  clientId,
  personName,
  roleLabels,
  owner,
  representativeId,
  current,
  currentRevision,
  disabled,
}: Props) {
  const router = useRouter();
  const { replaceRepresentatives, registerIdentityInvalidations } = useGwgIdentitySubjects();
  const { markDraft, markRiskInvalidated } = useGwgEditState();
  const [editing, setEditing] = useState(false);
  const [isRepresentative, setIsRepresentative] = useState(Boolean(representativeId));
  const [addOwnerRole, setAddOwnerRole] = useState(false);
  const [savedRevision, setSavedRevision] = useState(currentRevision);
  const [newRepresentativeId] = useState(() => crypto.randomUUID());
  const submittedRepresentatives = useMemo(() => {
    if (representativeId) {
      return current.representatives
        .filter((representative) => isRepresentative || representative.id !== representativeId)
        .map((representative, position) => ({ ...representative, position, isNew: false }));
    }
    if (!isRepresentative || !owner) {
      return current.representatives.map((representative) => ({
        ...representative,
        isNew: false,
      }));
    }
    return [
      ...current.representatives.map((representative) => ({
        ...representative,
        isNew: false,
      })),
      {
        id: newRepresentativeId,
        fullName: owner.fullName,
        position: current.representatives.length,
        linkedBeneficialOwnerId: owner.id,
        isNew: true,
      },
    ];
  }, [current.representatives, isRepresentative, newRepresentativeId, owner, representativeId]);
  const [state, action, pending] = useActionState<
    | (ActionResult & {
        reviewReset?: boolean;
        representatives?: EditableRepresentative[];
        invalidatedIdentitySets?: InvalidatedIdentitySet[];
        revision?: string;
      })
    | null,
    FormData
  >(async (previous, data) => {
    const result = await saveLegalEntityDetailsAction(previous, data);
    if (!result?.ok || !result.representatives) return result;
    replaceRepresentatives(result.representatives);
    registerIdentityInvalidations(result.invalidatedIdentitySets ?? []);
    if (result.revision) setSavedRevision(result.revision);
    if (result.reviewReset) markDraft();
    markRiskInvalidated();
    setEditing(false);
    router.refresh();
    return result;
  }, null);

  return (
    <details className="details-box">
      <summary>
        <BadgeCheck className="h-5 w-5 shrink-0 text-violet-600" aria-hidden="true" />
        <span className="min-w-0 flex-1 text-sm font-semibold text-primary">Rolle(n)</span>
        {roleLabels.map((role) => (
          <span key={role} className="badge badge-brand">
            {role}
          </span>
        ))}
      </summary>
      <div className="details-body space-y-4">
        {!editing ? (
          <>
            <dl className="grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted">Person</dt>
                <dd className="text-sm font-medium text-primary">{personName}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Zugeordnete Rollen</dt>
                <dd className="text-sm text-primary">{roleLabels.join(', ') || 'Keine'}</dd>
              </div>
            </dl>
            {!disabled && (
              <button
                type="button"
                className="btn-secondary text-xs"
                onClick={() => setEditing(true)}
              >
                <Pencil className="h-3.5 w-3.5" /> Bearbeiten
              </button>
            )}
          </>
        ) : (
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-3">
              <p className="text-xs text-muted">
                Rollen werden ausschließlich dieser bereits erfassten Person zugeordnet. Namen
                können hier nicht frei eingegeben werden.
              </p>
              <button
                type="button"
                className="modal-close"
                onClick={() => {
                  setIsRepresentative(Boolean(representativeId));
                  setAddOwnerRole(false);
                  setEditing(false);
                }}
                aria-label="Rollenbearbeitung schließen"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form action={action} className="space-y-3">
              <input type="hidden" name="checkId" value={checkId} />
              <input type="hidden" name="clientId" value={clientId} />
              <input type="hidden" name="expectedRevision" value={savedRevision} />
              <input type="hidden" name="legalForm" value={current.legalForm ?? ''} />
              <input type="hidden" name="registerNumber" value={current.registerNumber ?? ''} />
              <input
                type="hidden"
                name="registerAuthority"
                value={current.registerAuthority ?? ''}
              />
              <input
                type="hidden"
                name="noRegisterEntry"
                value={current.noRegisterEntry ? 'on' : ''}
              />
              <input
                type="hidden"
                name="ownershipStructureNotes"
                value={current.ownershipStructureNotes ?? ''}
              />
              <input
                type="hidden"
                name="representativesJson"
                value={JSON.stringify(submittedRepresentatives)}
              />

              <PersonRoleChoices
                owner={owner}
                addOwnerRole={addOwnerRole}
                setAddOwnerRole={setAddOwnerRole}
                pending={pending}
                isRepresentative={isRepresentative}
                setIsRepresentative={setIsRepresentative}
                representativeId={representativeId}
                state={state}
              />
            </form>

            {!owner && representativeId && addOwnerRole && (
              <AddBeneficialOwnerRoleForm
                checkId={checkId}
                clientId={clientId}
                representativeId={representativeId}
                personName={personName}
              />
            )}

            {owner && (
              <div className="border-t border-default pt-4">
                <BeneficialOwnerForm
                  ownerId={owner.id}
                  checkId={checkId}
                  clientId={clientId}
                  value={owner}
                  revision={owner.revision}
                  defaultOpen
                />
              </div>
            )}
          </div>
        )}
      </div>
    </details>
  );
}

function PersonRoleChoices({
  owner,
  addOwnerRole,
  setAddOwnerRole,
  pending,
  isRepresentative,
  setIsRepresentative,
  representativeId,
  state,
}: {
  owner: OwnerValue | null;
  addOwnerRole: boolean;
  setAddOwnerRole: (value: boolean) => void;
  pending: boolean;
  isRepresentative: boolean;
  setIsRepresentative: (value: boolean) => void;
  representativeId: string | null;
  state: ActionResult | null;
}) {
  return (
    <>
      <label className="flex items-center gap-2 text-sm text-secondary">
        <input
          type="checkbox"
          checked={Boolean(owner) || addOwnerRole}
          onChange={(event) => setAddOwnerRole(event.target.checked)}
          disabled={Boolean(owner) || pending}
          readOnly={Boolean(owner)}
        />
        Wirtschaftlich berechtigt
      </label>
      <label className="flex items-center gap-2 text-sm text-secondary">
        <input
          type="checkbox"
          checked={isRepresentative}
          onChange={(event) => setIsRepresentative(event.target.checked)}
          disabled={pending || (!owner && Boolean(representativeId))}
        />
        Gesetzliche Vertretung
      </label>
      {!owner && representativeId && (
        <p className="text-xs text-muted">
          Diese Person besitzt aktuell ausschließlich die Vertreterrolle. Damit sie als erfasste
          Person bestehen bleibt, kann die einzige Rolle hier nicht entfernt werden.
        </p>
      )}
      {owner && (
        <button type="submit" className="btn-primary text-xs" disabled={pending}>
          {pending ? 'Speichert…' : 'Rollen speichern'}
        </button>
      )}
      {state?.error && <div className="alert-error-sm">{state.error}</div>}
    </>
  );
}
