'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, X } from 'lucide-react';
import { addGwgPersonAction } from './owner-actions';
import type { ActionResult } from './actions';
import { useGwgEditState } from './edit-state-context';

export function NewGwgPersonForm({ checkId, clientId }: { checkId: string; clientId: string }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const { markDraft, markRiskInvalidated } = useGwgEditState();
  const [open, setOpen] = useState(false);
  const [isBeneficialOwner, setIsBeneficialOwner] = useState(false);
  const [isRepresentative, setIsRepresentative] = useState(true);
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    addGwgPersonAction,
    null,
  );

  useEffect(() => {
    if (!state?.ok) return;
    formRef.current?.reset();
    setIsBeneficialOwner(false);
    setIsRepresentative(true);
    setOpen(false);
    markDraft();
    markRiskInvalidated();
    router.refresh();
  }, [markDraft, markRiskInvalidated, router, state]);

  if (!open) {
    return (
      <button type="button" className="btn-primary mb-4 text-sm" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> Neue Person erfassen
      </button>
    );
  }

  return (
    <div className="mb-4 rounded-md border border-brand-200 bg-brand-50/30 p-4 dark:border-brand-900 dark:bg-brand-950/10">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-primary">Neue Person erfassen</h3>
          <p className="text-xs text-muted">
            Person einmal anlegen und anschließend die zutreffenden Rollen auswählen.
          </p>
        </div>
        <button
          type="button"
          className="modal-close"
          onClick={() => setOpen(false)}
          aria-label="Personenerfassung schließen"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <form ref={formRef} action={action} className="space-y-4">
        <input type="hidden" name="checkId" value={checkId} />
        <input type="hidden" name="clientId" value={clientId} />

        <fieldset className="space-y-3">
          <legend className="label">Allgemeine Angaben</legend>
          <p className="text-xs text-muted">
            Diese Angaben gehören zur Person und gelten unabhängig von ihren Rollen.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="label-sm" htmlFor="new-gwg-person-name">
                Name
              </label>
              <input
                id="new-gwg-person-name"
                name="fullName"
                className="input"
                maxLength={200}
                required
                disabled={pending}
              />
            </div>
            <div>
              <label className="label-sm" htmlFor="new-gwg-person-birth-date">
                Geburtsdatum
              </label>
              <input
                id="new-gwg-person-birth-date"
                name="birthDate"
                type="date"
                className="input"
                required
                disabled={pending}
              />
            </div>
            <div>
              <label className="label-sm" htmlFor="new-gwg-person-birth-place">
                Geburtsort
              </label>
              <input
                id="new-gwg-person-birth-place"
                name="birthPlace"
                className="input"
                maxLength={200}
                required
                disabled={pending}
              />
            </div>
            <div>
              <label className="label-sm" htmlFor="new-gwg-person-nationality">
                Staatsangehörigkeit
              </label>
              <input
                id="new-gwg-person-nationality"
                name="nationality"
                className="input"
                maxLength={100}
                required
                disabled={pending}
              />
            </div>
            <div>
              <label className="label-sm" htmlFor="new-gwg-person-residence">
                Wohnsitz
              </label>
              <input
                id="new-gwg-person-residence"
                name="residence"
                className="input"
                maxLength={500}
                required
                disabled={pending}
              />
            </div>
            <div>
              <label className="label-sm" htmlFor="new-gwg-person-pep">
                PEP-Status
              </label>
              <select
                id="new-gwg-person-pep"
                name="isPep"
                className="input"
                defaultValue="false"
                required
                disabled={pending}
              >
                <option value="false">Keine PEP</option>
                <option value="true">PEP / enges Familienmitglied</option>
              </select>
            </div>
          </div>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="label">Rolle(n)</legend>
          <label className="flex items-center gap-2 text-sm text-secondary">
            <input
              type="checkbox"
              name="isRepresentative"
              checked={isRepresentative}
              onChange={(event) => setIsRepresentative(event.target.checked)}
              disabled={pending}
            />
            Gesetzliche Vertretung
          </label>
          <label className="flex items-center gap-2 text-sm text-secondary">
            <input
              type="checkbox"
              name="isBeneficialOwner"
              checked={isBeneficialOwner}
              onChange={(event) => setIsBeneficialOwner(event.target.checked)}
              disabled={pending}
            />
            Wirtschaftlich berechtigt
          </label>
        </fieldset>

        {isBeneficialOwner && (
          <div className="space-y-3 border-t border-default pt-4">
            <p className="text-xs font-semibold text-primary">Rollenspezifische Angaben</p>
            <div className="max-w-xs">
              <label className="label-sm" htmlFor="new-gwg-person-ownership">
                Anteil (%)
              </label>
              <input
                id="new-gwg-person-ownership"
                name="ownershipPct"
                type="number"
                step="0.01"
                min="0"
                max="100"
                className="input"
                disabled={pending}
              />
            </div>
          </div>
        )}

        {state?.error && <div className="alert-error-sm">{state.error}</div>}
        <div className="flex gap-2">
          <button
            type="submit"
            className="btn-primary text-sm"
            disabled={pending || (!isRepresentative && !isBeneficialOwner)}
          >
            {pending ? 'Speichert…' : 'Person speichern'}
          </button>
          <button
            type="button"
            className="btn-secondary text-sm"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            Abbrechen
          </button>
        </div>
      </form>
    </div>
  );
}
