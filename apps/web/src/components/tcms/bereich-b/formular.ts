'use client';

// =============================================================================
// Formularzustand der Aktionen des Bereichs B (TCMS Stufe 3) – wie ActionForm
// der kanzleikonsole (components/action-form.tsx): React 19 setzt nach jeder
// Übermittlung über `<form action={fn}>` alle unkontrollierten Felder zurück,
// auch wenn die Aktion einen Fehler meldet. Der Submit-Handler startet die
// Aktion deshalb selbst in einer Transition; zurückgesetzt wird nur nach
// Erfolg, Eingaben bleiben bei Feld- oder Dienstfehlern stehen. Eine laufende
// Übermittlung wird nicht wiederholt (Doppelklick). `action` bleibt am
// Formular, damit die Server Action ohne JavaScript per POST erreichbar ist.
// =============================================================================

import { startTransition, useActionState, useEffect, useRef, type FormEvent } from 'react';
import { formDataWithSubmitter } from '@/components/action-form';
import type { TcmsAktionsErgebnis } from './ergebnis';

export function useTcmsFormular<E extends TcmsAktionsErgebnis = TcmsAktionsErgebnis>(
  aktion: (vorher: E | null, formData: FormData) => Promise<E>,
) {
  const ref = useRef<HTMLFormElement>(null);
  const unterwegs = useRef(false);
  const [ergebnis, ausfuehren, laeuft] = useActionState<E | null, FormData>(aktion, null);

  useEffect(() => {
    if (!laeuft) unterwegs.current = false;
  }, [laeuft]);

  useEffect(() => {
    if (ergebnis?.ok) ref.current?.reset();
  }, [ergebnis]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (unterwegs.current) return;
    unterwegs.current = true;
    const formData = formDataWithSubmitter(
      event.currentTarget,
      (event.nativeEvent as SubmitEvent).submitter,
    );
    startTransition(() => ausfuehren(formData));
  }

  return {
    ergebnis,
    laeuft,
    /** Props für `<form>`: ref, action (ohne JavaScript), onSubmit, aria-busy. */
    formular: { ref, action: ausfuehren, onSubmit, 'aria-busy': laeuft || undefined },
  };
}
