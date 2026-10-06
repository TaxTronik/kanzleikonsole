import { z, type output, type ZodType } from 'zod';
import { ActionError } from './action-error';

export type ValidationFailure = {
  ok: false;
  error: string;
  errorCode: 'VALIDATION_ERROR';
  fieldErrors: Record<string, string[]>;
};

export type FormDataParseResult<T> = { ok: true; data: T } | ValidationFailure;

const DEFAULT_VALIDATION_ERROR = 'Bitte prüfen Sie die markierten Angaben.';

type ValidationIssues = readonly { path: readonly PropertyKey[]; message: string }[];

/**
 * Zod-Issues → Validierungsfehler mit Feldzuordnung (Pfad `a.b`, ohne Pfad
 * `_form`). Für Actions, die ihr Schema bewusst selbst aus FormData befüllen.
 */
export function validationFailure(
  issues: ValidationIssues,
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
 * Zod-Prüfung typisierter Action-Eingaben (Objekt statt FormData) als
 * Ergebnis-Union: Validierungsfehler werden zum Feld-/Action-Fehler statt zu
 * einer ZodError-Exception, die toActionError nur generisch beantworten kann
 * (Review-Befund F-03: `safeParse` statt `parse`).
 */
export function parseActionInput<TSchema extends ZodType>(
  schema: TSchema,
  input: unknown,
  errorMessage?: string,
): FormDataParseResult<output<TSchema>> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return validationFailure(parsed.error.issues, errorMessage);
  return { ok: true, data: parsed.data };
}

/**
 * Standardisiert FormData → Zod für Server-Actions.
 *
 * Fehlende Felder bleiben `undefined`; leere Formularfelder bleiben `''`.
 * Wiederholbare Felder müssen explizit benannt werden, damit ein versehentlich
 * doppeltes skalares Feld nicht unbemerkt seine Form ändert. `errorMessage`
 * ist die Gesamtmeldung (fest oder aus den Issues); `fieldErrors` ordnet jede
 * Meldung ihrem Feld zu.
 *
 * `absentAsNull` (R-12): Felder des Objekt-Schemas, die im Formular fehlen,
 * kommen wie bei FormData#get als `null` an (wiederholbare wie bei getAll als
 * `[]`) — für die Umstellung handgeschriebener formData.get-Zuordnungen, ohne
 * dass sich akzeptierte Eingaben oder Meldungen ändern.
 */
export function parseFormData<TSchema extends ZodType>(
  schema: TSchema,
  formData: FormData,
  options: {
    repeatable?: readonly string[];
    errorMessage?: string | ((issues: ValidationIssues) => string);
    absentAsNull?: boolean;
  } = {},
): FormDataParseResult<output<TSchema>> {
  const repeatable = new Set(options.repeatable ?? []);
  const input: Record<string, FormDataEntryValue | FormDataEntryValue[] | null> = {};
  for (const key of new Set(formData.keys())) {
    // Preserve FormData#get's established first-value semantics for scalar
    // fields; only explicitly repeatable fields become arrays.
    const value = repeatable.has(key) ? formData.getAll(key) : formData.get(key);
    if (value !== null) input[key] = value;
  }
  if (options.absentAsNull) {
    for (const key of objectSchemaKeys(schema)) {
      if (!(key in input)) input[key] = repeatable.has(key) ? [] : null;
    }
  }

  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const message =
      typeof options.errorMessage === 'function'
        ? options.errorMessage(parsed.error.issues)
        : options.errorMessage;
    return validationFailure(parsed.error.issues, message);
  }
  return { ok: true, data: parsed.data };
}

/** Schlüssel eines (ggf. verfeinerten oder per `.transform` umgeformten) z.object-Schemas. */
function objectSchemaKeys(schema: ZodType): string[] {
  const shape = (schema as { shape?: Record<string, unknown> }).shape;
  if (shape) return Object.keys(shape);
  const input = (schema as { _zod?: { def?: { in?: ZodType } } })._zod?.def?.in;
  if (input) return objectSchemaKeys(input);
  throw new Error('parseFormData: absentAsNull braucht ein z.object-Schema.');
}

// -----------------------------------------------------------------------------
// Feldschemas für parseFormData mit `absentAsNull` (Review-Befund R-12). Sie
// bilden die bisherigen Umwandlungen nach `formData.get` nach; ein fehlendes
// Feld kommt dabei wie bei FormData#get als `null` an (ein nicht angehakter
// Haken, ein deaktiviertes oder bedingt gerendertes Feld fehlt im Formular).
// -----------------------------------------------------------------------------

/**
 * Checkbox/Schalter wie `formData.get(name) === on` (mehrere Werte wie
 * `=== 'on' || === '1'`); `schema` prüft den Wahrheitswert (z. B. eine
 * ausdrückliche Bestätigung mit `z.literal(true)`).
 */
export function formFlag<T extends ZodType = z.ZodBoolean>(
  on: string | readonly string[] = 'on',
  schema?: T,
) {
  const values: readonly unknown[] = typeof on === 'string' ? [on] : on;
  return z.preprocess((value) => values.includes(value), schema ?? z.boolean()) as z.ZodPipe<
    z.ZodTransform<boolean, unknown>,
    T
  >;
}

/** Wie `formData.get(name) ?? undefined`. */
export function formOptional<T extends ZodType>(schema: T) {
  return z.preprocess((value) => value ?? undefined, schema);
}

/** Wie `formData.get(name) ?? fallback`. */
export function formDefault<T extends ZodType>(fallback: string, schema: T) {
  return z.preprocess((value) => value ?? fallback, schema);
}

/** Wie `formData.get(name) || empty` (leer oder fehlend → `empty`). */
export function formEmpty<T extends ZodType>(empty: null | undefined, schema: T) {
  return z.preprocess((value) => value || empty, schema);
}

/** Wie `formData.getAll(name).map(String)`; das Feld steht in `repeatable`. */
export function formList<T extends ZodType>(schema: T) {
  return z.preprocess((value) => (Array.isArray(value) ? value.map(String) : value), schema);
}

/**
 * UUID-Parameter einer Action (z. B. aus einer gebundenen Action-Signatur):
 * ungültig → ActionError mit UI-tauglicher Meldung statt ZodError (F-03).
 */
export function requireUuidParam(value: unknown, message = 'Ungültige Kennung.'): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw new ActionError(message);
  return parsed.data;
}
