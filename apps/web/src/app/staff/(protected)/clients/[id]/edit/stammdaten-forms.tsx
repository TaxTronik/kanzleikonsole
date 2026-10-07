'use client';

import { useActionState, useEffect, useRef, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import {
  saveAdminFieldsAction,
  saveGwgFieldsAction,
  setResponsibilitiesAction,
  setMandateEndAction,
  type ActionResult,
} from './actions';
import { fmtDateShort } from '@/lib/fmt';
import {
  FieldError,
  FieldErrorsProvider,
  FormErrorSummary,
  fieldErrorProps,
  useFieldErrors,
  type FieldErrors,
} from '@/components/form-errors';

/** Ergebnis der Actions inkl. Feldfehler aus parseFormData (C7). */
type FormState = ActionResult & { fieldErrors?: FieldErrors };

/**
 * Reactivity-Helper: `revalidatePath` in der Server-Action lädt zwar die
 * Server-Component neu, aber React hält bei uncontrolled `<input
 * defaultChecked />` / `<select defaultValue>` den DOM-State fest. Nach einem
 * erfolgreichen Save zwingt `router.refresh()` Next, den Client-Tree zu
 * re-rendern — Checkboxen / Selects übernehmen dann die neuen Server-Werte.
 *
 * Plus: wenn `state.ok` zweimal hintereinander true wird (z. B. zwei rasch
 * aufeinanderfolgende Saves), würde `useEffect` ohne `previousRef` nicht erneut
 * triggern. Wir merken uns das State-Object und feuern bei jeder Veränderung.
 */
function useRefreshOnSuccess(state: FormState | null): void {
  const router = useRouter();
  const lastSaveRef = useRef<string | null>(null);
  useEffect(() => {
    if (state?.ok && state.savedAt && state.savedAt !== lastSaveRef.current) {
      lastSaveRef.current = state.savedAt;
      router.refresh();
    }
  }, [state, router]);
}

/** Feld-ID der Stammdatenfelder (Sprungziel der Fehlerzusammenfassung). */
function stammdatenFieldId(name: string): string {
  return `client-${name}`;
}

/**
 * Fehlerzusammenfassung am Ende der Karte (dort stand die Meldung bisher) und
 * Feldfehler für die server-gerenderten Felder in `children`.
 */
function StammdatenErrors({
  state,
  fieldIds,
}: {
  state: FormState | null;
  fieldIds?: Record<string, string>;
}) {
  if (!state || state.ok) return null;
  return (
    <div className="mt-4">
      <FormErrorSummary error={state.error} fieldErrors={state.fieldErrors} fieldIds={fieldIds} />
    </div>
  );
}

/**
 * Eingabefeld der Stammdaten (Label, Feld, Feldfehler). Client-Komponente,
 * damit es die Feldfehler des umgebenden Formulars liest; Initialwerte kommen
 * weiterhin aus der Server-Component.
 */
export function StammdatenField({
  label,
  name,
  defaultValue,
  type = 'text',
  required,
  placeholder,
  colspan,
}: {
  label: string;
  name: string;
  defaultValue: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  colspan?: 2;
}) {
  const fieldErrors = useFieldErrors();
  const id = stammdatenFieldId(name);
  return (
    <div className={colspan === 2 ? 'col-span-2' : ''}>
      <label className="label-sm" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type={type}
        name={name}
        defaultValue={defaultValue}
        required={required}
        placeholder={placeholder}
        className="input w-full"
        {...fieldErrorProps(name, fieldErrors)}
      />
      <FieldError name={name} errors={fieldErrors?.[name]} />
    </div>
  );
}

/** Save-Button mit Pending-Label. */
function SaveButton({
  isPending,
  label,
  savingLabel,
}: {
  isPending: boolean;
  label: string;
  savingLabel?: string;
}) {
  return (
    <button type="submit" className="btn-primary" disabled={isPending}>
      {isPending ? (savingLabel ?? 'Speichert…') : label}
    </button>
  );
}

/**
 * Sektion 1 — Verwaltungsdaten (frei änderbar).
 * Children = die echten Form-Felder, vom Server-Component übergeben (damit der
 * Initialwert serverseitig vorgehalten wird).
 */
export function AdminFieldsForm({ clientId, children }: { clientId: string; children: ReactNode }) {
  const [state, formAction, isPending] = useActionState<FormState | null, FormData>(
    saveAdminFieldsAction,
    null,
  );
  useRefreshOnSuccess(state);

  return (
    <form action={formAction} className="card p-6 mb-6">
      <h2 className="text-sm font-medium text-primary mb-4">Verwaltung (frei änderbar)</h2>
      <input type="hidden" name="clientId" value={clientId} />
      <FieldErrorsProvider fieldErrors={state?.fieldErrors}>{children}</FieldErrorsProvider>
      <StammdatenErrors
        state={state}
        fieldIds={{
          datevNo: stammdatenFieldId('datevNo'),
          addisonNo: stammdatenFieldId('addisonNo'),
          invoiceEmail: stammdatenFieldId('invoiceEmail'),
          priority: 'client-priority',
          internalNotes: 'client-internal-notes',
          vertraulich: 'client-confidential',
        }}
      />
      {state?.ok && <p className="alert-success-sm mt-4">Verwaltungsdaten gespeichert.</p>}
      <div className="flex justify-end mt-4">
        <SaveButton isPending={isPending} label="Speichern" />
      </div>
    </form>
  );
}

export function ResponsibilitiesForm({
  clientId,
  children,
}: {
  clientId: string;
  children: ReactNode;
}) {
  const [state, formAction, isPending] = useActionState<FormState | null, FormData>(
    setResponsibilitiesAction,
    null,
  );
  useRefreshOnSuccess(state);

  return (
    <form action={formAction} className="card p-6 mb-6">
      <h2 className="text-sm font-medium text-primary mb-1">Zuständigkeit</h2>
      <p className="text-xs text-muted mb-4">
        Berufsträger: verantwortliche/r Steuerberater/in (§ 32 StBerG) — mehrere möglich bei
        geteilten Mandaten. Bearbeiter: Mitarbeiter, die den Mandanten betreuen und in „Meine
        Mandanten" sehen.
      </p>
      <input type="hidden" name="clientId" value={clientId} />
      <FieldErrorsProvider fieldErrors={state?.fieldErrors}>{children}</FieldErrorsProvider>
      <StammdatenErrors state={state} />
      {state?.ok && <p className="alert-success-sm mt-4">Zuordnung gespeichert.</p>}
      <div className="flex justify-end mt-4">
        <SaveButton isPending={isPending} label="Zuordnung speichern" />
      </div>
    </form>
  );
}

/**
 * Mandatsende — startet/stoppt die GwG-Lösch-Uhr (§ 8 Abs. 4). Reversibel
 * (wieder aufnehmen löscht das Datum), daher kein harter Confirm.
 */
export function MandateForm({
  clientId,
  mandateEndedAt,
}: {
  clientId: string;
  mandateEndedAt: string | null;
}) {
  const [state, formAction, isPending] = useActionState<FormState | null, FormData>(
    setMandateEndAction,
    null,
  );
  useRefreshOnSuccess(state);
  const ended = mandateEndedAt != null;

  return (
    <form action={formAction} className="card p-6 mb-6 border-amber-200">
      <h2 className="text-sm font-medium text-primary mb-1">Mandatsende (GwG-Aufbewahrung)</h2>
      <p className="text-xs text-muted mb-4">
        Markiert das Ende der Geschäftsbeziehung und startet die 5-Jahres-Lösch-Uhr (§ 8 Abs. 4 GwG)
        für die GwG-Belege. Nach Fristablauf erscheinen sie unter Admin → GwG-Pflichtlöschung zur
        bestätigten Vernichtung.
      </p>
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="ended" value={ended ? '0' : '1'} />
      <p className="text-sm">
        {ended ? (
          <>
            Mandat beendet seit <strong>{fmtDateShort(new Date(mandateEndedAt!))}</strong>.
          </>
        ) : (
          <span className="text-muted">Mandat ist aktiv.</span>
        )}
      </p>
      <StammdatenErrors state={state} />
      {state?.ok && <p className="alert-success-sm mt-4">Gespeichert.</p>}
      <div className="flex justify-end mt-4">
        <SaveButton
          isPending={isPending}
          label={ended ? 'Mandat wieder aufnehmen' : 'Mandat beenden'}
        />
      </div>
    </form>
  );
}

export function GwgFieldsForm({ clientId, children }: { clientId: string; children: ReactNode }) {
  const [state, formAction, isPending] = useActionState<FormState | null, FormData>(
    saveGwgFieldsAction,
    null,
  );
  useRefreshOnSuccess(state);

  return (
    <form action={formAction} className="card p-6 mb-6 border-amber-200">
      <input type="hidden" name="clientId" value={clientId} />
      <FieldErrorsProvider fieldErrors={state?.fieldErrors}>{children}</FieldErrorsProvider>
      <StammdatenErrors
        state={state}
        fieldIds={{
          name: stammdatenFieldId('name'),
          kind: 'client-kind',
          street: stammdatenFieldId('street'),
          postalCode: stammdatenFieldId('postalCode'),
          city: stammdatenFieldId('city'),
          countryIso: stammdatenFieldId('countryIso'),
        }}
      />
      {state?.ok && (
        <p className="alert-success-sm mt-4">
          GwG-Stammdaten gespeichert. Wenn relevante Felder geändert wurden, ist die GwG-Prüfung auf{' '}
          <strong>IN_REVIEW</strong> zurückgesetzt.
        </p>
      )}
      <div className="flex justify-end mt-4">
        <SaveButton isPending={isPending} label="GwG-Stammdaten speichern" />
      </div>
    </form>
  );
}
