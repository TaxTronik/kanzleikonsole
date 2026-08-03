// =============================================================================
// Priorität einer Wiedervorlage — Labels, Badge-Klassen, Sortierung.
//
// Bewusst zod- und serverfrei (Client-Bundle): dieselbe Skala wie bei
// Anforderungen, damit Übersicht und Mandantenseite gleich aussehen.
// =============================================================================

export const REMINDER_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;

export type ReminderPriority = (typeof REMINDER_PRIORITIES)[number];

export const PRIORITY_LABEL: Record<ReminderPriority, string> = {
  LOW: 'Niedrig',
  NORMAL: 'Normal',
  HIGH: 'Hoch',
  URGENT: 'Dringend',
};

/** Badge-Klasse; NORMAL bleibt bewusst unmarkiert (sonst rauscht die Liste). */
export const PRIORITY_BADGE: Record<ReminderPriority, string | null> = {
  LOW: 'badge-gray',
  NORMAL: null,
  HIGH: 'badge-yellow',
  URGENT: 'badge-red',
};

const RANG: Record<ReminderPriority, number> = { URGENT: 0, HIGH: 1, NORMAL: 2, LOW: 3 };

/**
 * Sortiert dringend nach oben, danach nach Fälligkeit.
 *
 * Wichtig für die Übersicht: eine hochgestufte Aufgabe soll sofort obenauf
 * liegen, auch wenn ihr Datum weiter weg ist als das einer normalen.
 */
export function byPriorityThenDue<T extends { priority: ReminderPriority; dueDate: string }>(
  a: T,
  b: T,
): number {
  const p = RANG[a.priority] - RANG[b.priority];
  return p !== 0 ? p : a.dueDate.localeCompare(b.dueDate);
}
