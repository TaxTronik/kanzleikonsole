'use client';

// =============================================================================
// Formularzustand der Tax-CMS-Aktionen (Integration TCMS Stufe 3; aus Bereich B
// gehoben, mit der Bestätigung aus Bereich D) – ein Baustein für alle Bereiche.
//
// React 19 setzt nach jeder Übermittlung über `<form action={fn}>` alle
// unkontrollierten Felder zurück, auch wenn die Aktion einen Fehler meldet
// (wie ActionForm der kanzleikonsole, components/action-form.tsx). Der
// Submit-Handler startet die Aktion deshalb selbst in einer Transition:
//   - Eingaben bleiben bei Feld- oder Dienstfehlern immer stehen;
//   - zurückgesetzt wird nur nach Erfolg und nur mit `zuruecksetzen`
//     (Standard; Formulare, die nach Erfolg schließen oder weiterleiten,
//     schalten es ab);
//   - eine laufende Übermittlung wird nicht wiederholt (Doppelklick);
//   - optional fragt der Gefahrendialog der kanzleikonsole vorher nach
//     (`bestaetigung`, auch abhängig vom auslösenden Knopf);
//   - `nachLesen(form)` läuft direkt nach dem Lesen der Formulardaten (z. B. ein
//     Codefeld leeren, damit der Wert nicht im Formular stehen bleibt).
// `action` bleibt am Formular, damit die Server Action ohne JavaScript per POST
// erreichbar ist.
// =============================================================================

import {
  startTransition,
  useActionState,
  useEffect,
  useRef,
  type FormEvent,
  type ReactNode,
} from 'react';
import { formDataWithSubmitter } from '@/components/action-form';
import { confirmDialog } from '@/components/ui/modal';
import type { TcmsAktionsErgebnis, TcmsFormAktion } from './ergebnis';

export type { TcmsAktionsErgebnis, TcmsFormAktion } from './ergebnis';

/** Rückfrage vor dem Absenden (Gefahrendialog bei `gefahr`). */
export interface TcmsBestaetigung {
  text: ReactNode;
  titel?: string;
  bestaetigen?: string;
  /** Destruktiver Schritt: Gefahrendialog. */
  gefahr?: boolean;
}

export interface TcmsFormularOptionen {
  /** Nach Erfolg zurücksetzen (Standard: ja). Bei Fehlern bleiben Eingaben immer stehen. */
  zuruecksetzen?: boolean;
  /** Rückfrage vor dem Absenden; als Funktion abhängig vom auslösenden Knopf (null: keine). */
  bestaetigung?: TcmsBestaetigung | ((submitter: Element | null) => TcmsBestaetigung | null);
  /** Läuft nach dem Lesen der Formulardaten, vor dem Absenden. */
  nachLesen?: (form: HTMLFormElement) => void;
}

export function useTcmsFormular<E extends TcmsAktionsErgebnis = TcmsAktionsErgebnis>(
  aktion: TcmsFormAktion<E>,
  optionen: TcmsFormularOptionen = {},
) {
  const ref = useRef<HTMLFormElement>(null);
  const unterwegs = useRef(false);
  const [ergebnis, ausfuehren, laeuft] = useActionState<E | null, FormData>(aktion, null);
  const zuruecksetzen = optionen.zuruecksetzen ?? true;

  useEffect(() => {
    if (!laeuft) unterwegs.current = false;
  }, [laeuft]);

  useEffect(() => {
    if (zuruecksetzen && ergebnis?.ok) ref.current?.reset();
  }, [ergebnis, zuruecksetzen]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (unterwegs.current) return;
    const form = event.currentTarget;
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const senden = () => {
      if (unterwegs.current) return;
      unterwegs.current = true;
      const formData = formDataWithSubmitter(form, submitter);
      optionen.nachLesen?.(form);
      startTransition(() => ausfuehren(formData));
    };
    const b =
      typeof optionen.bestaetigung === 'function'
        ? optionen.bestaetigung(submitter)
        : optionen.bestaetigung;
    if (!b) {
      senden();
      return;
    }
    void confirmDialog(b.text, {
      ...(b.titel ? { title: b.titel } : {}),
      ...(b.bestaetigen ? { confirmLabel: b.bestaetigen } : {}),
      danger: b.gefahr ?? false,
    }).then((ok) => {
      if (ok && form.isConnected) senden();
    });
  }

  return {
    ergebnis,
    laeuft,
    onSubmit,
    /** Props für `<form>`: ref, action (ohne JavaScript), onSubmit, aria-busy. */
    formular: { ref, action: ausfuehren, onSubmit, 'aria-busy': laeuft || undefined },
  };
}
