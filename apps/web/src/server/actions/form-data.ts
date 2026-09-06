import type { output, ZodType } from 'zod';

export type FormDataParseResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: string;
      errorCode: 'VALIDATION_ERROR';
      fieldErrors: Record<string, string[]>;
    };

/**
 * Standardisiert FormData → Zod für Server-Actions.
 *
 * Fehlende Felder bleiben `undefined`; leere Formularfelder bleiben `''`.
 * Wiederholbare Felder müssen explizit benannt werden, damit ein versehentlich
 * doppeltes skalares Feld nicht unbemerkt seine Form ändert.
 */
export function parseFormData<TSchema extends ZodType>(
  schema: TSchema,
  formData: FormData,
  options: {
    repeatable?: readonly string[];
    errorMessage?: string;
  } = {},
): FormDataParseResult<output<TSchema>> {
  const repeatable = new Set(options.repeatable ?? []);
  const input: Record<string, FormDataEntryValue | FormDataEntryValue[]> = {};
  for (const key of new Set(formData.keys())) {
    // Preserve FormData#get's established first-value semantics for scalar
    // fields; only explicitly repeatable fields become arrays.
    const value = repeatable.has(key) ? formData.getAll(key) : formData.get(key);
    if (value !== null) input[key] = value;
  }

  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.') || '_form';
      (fieldErrors[key] ??= []).push(issue.message);
    }
    return {
      ok: false,
      error: options.errorMessage ?? 'Bitte prüfen Sie die markierten Angaben.',
      errorCode: 'VALIDATION_ERROR',
      fieldErrors,
    };
  }
  return { ok: true, data: parsed.data };
}
