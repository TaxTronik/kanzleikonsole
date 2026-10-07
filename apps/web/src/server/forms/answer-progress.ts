// =============================================================================
// Gespeicherter Bearbeitungsfortschritt einer Formular-Einreichung (P-19)
//
// Die Jahreswechsel-Übersicht berechnete den Fortschritt je angezeigtem
// Eintrag im Render aus eingefrorenem Schema und Antworten (beides JSON, je
// Feld eine Validierung). Jetzt berechnen ihn die Schreibpfade, die Antworten
// ändern (Portal: Entwurf, Abgabe, Datei anfügen/lösen; Kampagnen-Rollout mit
// leeren Antworten), mit derselben Funktion formAnswerProgress aus genau den
// gespeicherten Antworten und schreiben ihn im SELBEN Update in
// form_submission.answer_progress_*. Die Übersicht liest nur noch die Zahlen.
//
// Der Trigger form_submission_answer_progress_stale (Migration 20261007160100)
// setzt den Wert zurück, wenn ein anderer Schreibpfad die Antworten ändert,
// ohne ihn neu zu berechnen (erkennbar an unverändertem answer_progress_at;
// neu berechnete Werte tragen deshalb immer einen späteren Zeitstempel).
// Die Migration trägt ihn für Jahreswechsel-Einreichungen mit leeren Antworten
// nach (dort steht er ohne Feldvalidierung fest). Ohne gespeicherten Wert
// (übriger Altbestand, solche Schreibpfade) berechnet die Übersicht wie bisher
// selbst. Die Anzeige bleibt technisch und beweist keine inhaltliche
// Vollständigkeit (YEAR-END-CAMPAIGN-001).
// =============================================================================

import type { Prisma } from '@prisma/client';
import { formAnswerProgress } from '@/server/workflows/dashboard-policy';

export type AnswerProgress = NonNullable<ReturnType<typeof formAnswerProgress>>;

/** Spalten des gespeicherten Fortschritts (Prisma-Feldnamen). */
export interface AnswerProgressColumns {
  answerProgressAt: Date | null;
  answerProgressFilled: number | null;
  answerProgressTotal: number | null;
  answerProgressRequiredFilled: number | null;
  answerProgressRequiredTotal: number | null;
}

export const ANSWER_PROGRESS_SELECT = {
  answerProgressAt: true,
  answerProgressFilled: true,
  answerProgressTotal: true,
  answerProgressRequiredFilled: true,
  answerProgressRequiredTotal: true,
} as const satisfies Prisma.FormSubmissionSelect;

/**
 * Fortschritt für genau diese neuen Antworten der (unter Zeilensperre
 * geladenen) Einreichung, als Update-Daten. Der Zeitstempel markiert den Wert
 * als im selben Update neu berechnet (Trigger); er liegt deshalb immer nach dem
 * gespeicherten, auch bei zwei Speicherungen in derselben Millisekunde oder
 * nachgehender Uhr. Ist der Formularstand nicht auswertbar, bleiben die Zahlen
 * leer („nicht berechenbar“).
 */
export function answerProgressColumns(
  submission: { schemaSnapshot: unknown; answerProgressAt?: Date | null },
  answers: unknown,
  now: Date = new Date(),
): AnswerProgressColumns {
  const progress = formAnswerProgress(submission.schemaSnapshot, answers);
  const previous = submission.answerProgressAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  return {
    answerProgressAt: now.getTime() > previous ? now : new Date(previous + 1),
    answerProgressFilled: progress?.filled ?? null,
    answerProgressTotal: progress?.total ?? null,
    answerProgressRequiredFilled: progress?.requiredFilled ?? null,
    answerProgressRequiredTotal: progress?.requiredTotal ?? null,
  };
}

/**
 * Gespeicherter Fortschritt: `undefined`, wenn keiner gespeichert ist (dann
 * selbst berechnen), `null`, wenn er als „nicht berechenbar“ gespeichert ist.
 */
export function storedAnswerProgress(
  row: AnswerProgressColumns,
): AnswerProgress | null | undefined {
  if (!row.answerProgressAt) return undefined;
  const {
    answerProgressFilled: filled,
    answerProgressTotal: total,
    answerProgressRequiredFilled: requiredFilled,
    answerProgressRequiredTotal: requiredTotal,
  } = row;
  if (filled === null || total === null || requiredFilled === null || requiredTotal === null) {
    return null;
  }
  return {
    filled,
    total,
    requiredFilled,
    requiredTotal,
    percent: total ? Math.round((filled / total) * 100) : null,
  };
}
