export type PhoneNoteReminderStatus = 'DONE' | 'OVERDUE' | 'DUE_TODAY' | 'OPEN';

/**
 * Leitet den kompakten Anzeigestatus einer Wiedervorlage aus ihren
 * persistierten Feldern ab. `dueDate` und `todayYmd` sind Kalendertage im
 * Format YYYY-MM-DD; dadurch gibt es an der Berlin-/UTC-Tagesgrenze keinen
 * wechselnden SSR-/Hydration-Status.
 */
export function phoneNoteReminderStatus(
  input: { dueDate: string; doneAt: string | null },
  todayYmd: string,
): PhoneNoteReminderStatus {
  if (input.doneAt) return 'DONE';
  const dueYmd = input.dueDate.slice(0, 10);
  if (dueYmd < todayYmd) return 'OVERDUE';
  if (dueYmd === todayYmd) return 'DUE_TODAY';
  return 'OPEN';
}
