import type { output, ZodType } from 'zod';

export type ValidationFailure = {
  ok: false;
  error: string;
  errorCode: 'VALIDATION_ERROR';
  fieldErrors: Record<string, string[]>;
};

export type FormDataParseResult<T> = { ok: true; data: T } | ValidationFailure;

const DEFAULT_VALIDATION_ERROR = 'Bitte prüfen Sie die markierten Angaben.';

/**
 * Zod-Issues → Validierungsfehler mit Feldzuordnung (Pfad `a.b`, ohne Pfad
 * `_form`). Für Actions, die ihr Schema bewusst selbst aus FormData befüllen.
 */
export function validationFailure(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
  error: string = DEFAULT_VALIDATION_ERROR,
): ValidationFailure {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of issues) {
    const key = issue.path.join('.') || '_form';
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return { ok: false, error, errorCode: 'VALIDATION_ERROR', fieldErrors };
}

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
    return validationFailure(parsed.error.issues, options.errorMessage);
  }
  return { ok: true, data: parsed.data };
}
