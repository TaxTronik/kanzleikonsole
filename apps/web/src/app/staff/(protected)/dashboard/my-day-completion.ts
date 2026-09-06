type CompletionAction = (input: {
  id: string;
  done: boolean;
}) => Promise<{ ok: boolean; error?: string }>;

export async function myDayCompletionError(
  id: string,
  complete: CompletionAction,
): Promise<string | null> {
  try {
    const result = await complete({ id, done: true });
    return result.ok ? null : (result.error ?? 'Aufgabe konnte nicht erledigt werden.');
  } catch {
    return 'Aufgabe konnte nicht erledigt werden. Bitte erneut versuchen.';
  }
}
