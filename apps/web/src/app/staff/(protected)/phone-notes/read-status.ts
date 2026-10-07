'use client';

// „Als gelesen markieren“ für Telefonnotizen (Review C1): verdrahtet die
// bestehende markNoteReadAction mit der Telefonzettel-Liste (globale Liste und
// Mandanten-Cockpit). Beide Listen erscheinen nur bei aktivem Modul
// `phoneNotes` und zeigen nur zugängliche Notizen — dasselbe Gate wie die
// Action. Nach Erfolg verschwindet „ungelesen“ sofort; die lokale Markierung
// gilt nur bis zum nächsten Server-Stand (router.refresh liefert neue
// Notizen), danach entscheidet wieder `readAt` — auch wenn eine Weiterleitung
// es zurückgesetzt hat.

import { useState, type TransitionStartFunction } from 'react';
import { noticeDialog } from '@/components/ui/modal';
import { markNoteReadAction } from './actions';

export const MARK_READ_LABEL = 'Als gelesen markieren';

interface ReadStatusNote {
  id: string;
  readAt: string | null;
}

/** Lokal als gelesen markierte Notizen, gebunden an den Server-Stand `notes`. */
export interface PhoneNoteReadState {
  notes: readonly ReadStatusNote[];
  ids: ReadonlySet<string>;
}

const NO_IDS: ReadonlySet<string> = new Set();

export function createPhoneNoteReadState(notes: readonly ReadStatusNote[]): PhoneNoteReadState {
  return { notes, ids: NO_IDS };
}

/** Übernimmt einen Erfolg; ein neuer Server-Stand verwirft ältere Markierungen. */
export function withNoteMarkedRead(
  state: PhoneNoteReadState,
  notes: readonly ReadStatusNote[],
  noteId: string,
): PhoneNoteReadState {
  const ids = new Set(state.notes === notes ? state.ids : NO_IDS);
  ids.add(noteId);
  return { notes, ids };
}

export function isPhoneNoteUnread(
  state: PhoneNoteReadState,
  notes: readonly ReadStatusNote[],
  note: ReadStatusNote,
): boolean {
  if (note.readAt) return false;
  return !(state.notes === notes && state.ids.has(note.id));
}

export function markReadFormData(noteId: string): FormData {
  const formData = new FormData();
  formData.set('noteId', noteId);
  return formData;
}

export function usePhoneNoteReadStatus(
  notes: readonly ReadStatusNote[],
  {
    startTransition,
    router,
  }: { startTransition: TransitionStartFunction; router: { refresh: () => void } },
) {
  const [state, setState] = useState(() => createPhoneNoteReadState(notes));

  function markRead(noteId: string) {
    startTransition(async () => {
      const result = await markNoteReadAction(null, markReadFormData(noteId));
      if (!result.ok) {
        await noticeDialog(
          result.error ?? 'Die Telefonnotiz konnte nicht als gelesen markiert werden.',
          { title: MARK_READ_LABEL },
        );
        return;
      }
      setState((current) => withNoteMarkedRead(current, notes, noteId));
      router.refresh();
    });
  }

  return {
    isUnread: (note: ReadStatusNote) => isPhoneNoteUnread(state, notes, note),
    markRead,
  };
}
