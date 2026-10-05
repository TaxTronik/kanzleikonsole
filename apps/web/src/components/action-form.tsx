'use client';

// =============================================================================
// ActionForm — Formular für Server-Actions mit ActionResult-Rückkanal.
//
// Für Actions der Form `(prev, formData) => Promise<ActionResult>`: Fehler
// (ActionError, Validierung, fehlende Berechtigung) erscheinen im Formular statt
// in error.tsx, und die Eingaben bleiben stehen. Die Felder kommen als children
// aus der Server-Component (wie bei den Stammdaten-Formularen).
//
// Eigener Submit-Handler: React 19 setzt nach jeder Übermittlung über
// `<form action={fn}>` alle unkontrollierten Felder zurück — auch dann, wenn die
// Action einen Fehler meldet. Der Handler startet die Action deshalb selbst in
// einer Transition (kein automatischer Reset, useFormStatus bleibt aktiv) und
// setzt das Formular wie bisher nur nach einem Erfolg zurück. `action` bleibt am
// Formular, damit die Server-Action ohne JavaScript weiter per POST erreichbar ist.
//
// Mehrere Actions je Formular (Sammelaktionen): Submit-Buttons wählen per
// `data-action="<schlüssel>"` einen Eintrag aus `actions`; ohne Attribut gilt
// `action`. Ein Formular hat genau einen Ergebnis-Zustand.
// =============================================================================

import {
  startTransition,
  useActionState,
  useEffect,
  useRef,
  type ComponentPropsWithoutRef,
  type FormEvent,
  type ReactNode,
} from 'react';
import { FormErrorSummary } from '@/components/form-errors';
import type { ActionResult } from '@/server/actions/types';

export type FormAction = (
  previous: ActionResult | null,
  formData: FormData,
) => Promise<ActionResult>;

type ActionFormProps = Omit<
  ComponentPropsWithoutRef<'form'>,
  'action' | 'onSubmit' | 'children'
> & {
  action: FormAction;
  /** Weitere Actions, ausgewählt über `data-action` am Submit-Button. */
  actions?: Readonly<Record<string, FormAction>>;
  children: ReactNode;
  /**
   * `summary` (Standard): FormErrorSummary oberhalb der Felder.
   * `inline`: kurze Meldung unter dem Inhalt, für reine Button-Formulare.
   */
  errorDisplay?: 'summary' | 'inline';
  /** Feldname → Element-ID, damit die Zusammenfassung auf die Felder verlinkt. */
  fieldIds?: Record<string, string>;
};

// Nur clientseitig: wird vor dem Aufruf der Server-Action wieder entfernt.
const ACTION_KEY_FIELD = '__actionFormKey';

/** FormData inkl. name/value des auslösenden Buttons — wie Reacts eigene Form-Actions. */
export function formDataWithSubmitter(form: HTMLFormElement, submitter: Element | null): FormData {
  if (
    !(submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement) ||
    !submitter.name
  ) {
    return new FormData(form);
  }
  const marker = submitter.ownerDocument.createElement('input');
  marker.type = 'hidden';
  marker.name = submitter.name;
  marker.value = submitter.value;
  if (form.id) marker.setAttribute('form', form.id);
  submitter.parentNode?.insertBefore(marker, submitter);
  try {
    return new FormData(form);
  } finally {
    marker.remove();
  }
}

export function ActionFormError({
  state,
  errorDisplay,
  fieldIds,
}: {
  state: ActionResult | null;
  errorDisplay: 'summary' | 'inline';
  fieldIds?: Record<string, string>;
}) {
  if (!state || state.ok) return null;
  if (errorDisplay === 'summary') {
    return (
      <FormErrorSummary error={state.error} fieldErrors={state.fieldErrors} fieldIds={fieldIds} />
    );
  }
  return (
    <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-400">
      {state.error ?? 'Aktion fehlgeschlagen.'}
    </p>
  );
}

export function ActionForm({
  action,
  actions,
  children,
  errorDisplay = 'summary',
  fieldIds,
  ...formProps
}: ActionFormProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const inFlight = useRef(false);
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    actions
      ? (previous, formData) => {
          const key = formData.get(ACTION_KEY_FIELD);
          formData.delete(ACTION_KEY_FIELD);
          const selected = typeof key === 'string' ? actions[key] : undefined;
          return (selected ?? action)(previous, formData);
        }
      : action,
    null,
  );

  useEffect(() => {
    if (!pending) inFlight.current = false;
  }, [pending]);

  useEffect(() => {
    // Erfolg: wie zuvor auf die (ggf. neu gerenderten) Ausgangswerte zurücksetzen.
    if (state?.ok) formRef.current?.reset();
  }, [state]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Doppelklick: die laufende Übermittlung abwarten statt sie zu wiederholen.
    if (inFlight.current) return;
    inFlight.current = true;
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const formData = formDataWithSubmitter(event.currentTarget, submitter);
    const key = submitter?.getAttribute('data-action');
    if (actions && key) formData.set(ACTION_KEY_FIELD, key);
    startTransition(() => formAction(formData));
  }

  return (
    <form
      {...formProps}
      ref={formRef}
      action={formAction}
      onSubmit={submit}
      aria-busy={pending || undefined}
    >
      {errorDisplay === 'summary' ? (
        <ActionFormError state={state} errorDisplay="summary" fieldIds={fieldIds} />
      ) : null}
      {children}
      {errorDisplay === 'inline' ? <ActionFormError state={state} errorDisplay="inline" /> : null}
    </form>
  );
}
