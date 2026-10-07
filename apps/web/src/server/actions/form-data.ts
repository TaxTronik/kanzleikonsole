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

// -----------------------------------------------------------------------------
// Deutsche Feldmeldungen (Review C7). Zods Standardmeldungen sind englisch
// („Too small: expected string to have >=1 characters“). Statt einer globalen
// Zod-Locale (`z.config`) geben parseFormData und parseActionInput diese
// Fehlerkarte pro Prüfung mit: Nur die Formular- und Action-Schemas dieser
// Helfer melden deutsch, andere Zod-Prüfungen (Konfiguration, APIs, Worker)
// bleiben unberührt. Eigene Meldungen am Schema (`.min(1, '…')`, `addIssue`)
// haben Vorrang. Eigene safeParse-Aufrufe vor `validationFailure` übergeben
// `{ error: germanFieldError }` selbst.
// -----------------------------------------------------------------------------

const GERMAN_NUMBER = new Intl.NumberFormat('de-DE');
const num = (value: number | bigint) => GERMAN_NUMBER.format(value);

function germanTooSmall(issue: z.core.$ZodRawIssue<z.core.$ZodIssueTooSmall>): string {
  const { minimum } = issue;
  switch (issue.origin) {
    case 'string':
      if (issue.exact) return `Genau ${num(minimum)} Zeichen.`;
      return Number(minimum) <= 1 ? 'Pflichtfeld.' : `Mindestens ${num(minimum)} Zeichen.`;
    case 'array':
    case 'set':
      return Number(minimum) <= 1
        ? 'Bitte mindestens einen Eintrag auswählen.'
        : `Mindestens ${num(minimum)} Einträge.`;
    case 'date':
      return 'Das Datum liegt zu früh.';
    case 'file':
      return 'Die Datei ist zu klein.';
    default:
      return issue.inclusive === false
        ? `Muss größer als ${num(minimum)} sein.`
        : `Mindestens ${num(minimum)}.`;
  }
}

function germanTooBig(issue: z.core.$ZodRawIssue<z.core.$ZodIssueTooBig>): string {
  const { maximum } = issue;
  switch (issue.origin) {
    case 'string':
      return issue.exact ? `Genau ${num(maximum)} Zeichen.` : `Höchstens ${num(maximum)} Zeichen.`;
    case 'array':
    case 'set':
      return `Höchstens ${num(maximum)} Einträge.`;
    case 'date':
      return 'Das Datum liegt zu spät.';
    case 'file':
      return 'Die Datei ist zu groß.';
    default:
      return issue.inclusive === false
        ? `Muss kleiner als ${num(maximum)} sein.`
        : `Höchstens ${num(maximum)}.`;
  }
}

const GERMAN_FORMATS: Readonly<Record<string, string>> = {
  email: 'Bitte eine gültige E-Mail-Adresse angeben.',
  url: 'Bitte eine gültige URL angeben.',
  date: 'Bitte ein gültiges Datum angeben.',
  datetime: 'Bitte einen gültigen Zeitpunkt angeben.',
  time: 'Bitte eine gültige Uhrzeit angeben.',
  uuid: 'Ungültige Auswahl.',
  guid: 'Ungültige Auswahl.',
};

/** Datumsfelder prüfen viele Schemas per Muster `^\d{4}-\d{2}-\d{2}$` statt `z.iso.date()`. */
const ISO_DATE_PATTERN = String.raw`\d{4}-\d{2}-\d{2}`;

function germanInvalidType(issue: z.core.$ZodRawIssue<z.core.$ZodIssueInvalidType>): string {
  if (issue.input === undefined || issue.input === null) return 'Pflichtfeld.';
  if (issue.expected === 'int') return 'Bitte eine ganze Zahl angeben.';
  if (issue.expected === 'number' || issue.expected === 'bigint') return 'Bitte eine Zahl angeben.';
  if (issue.expected === 'date') return GERMAN_FORMATS.date!;
  return 'Ungültige Eingabe.';
}

function germanInvalidFormat(
  issue: z.core.$ZodRawIssue<z.core.$ZodIssueInvalidStringFormat>,
): string {
  if (issue.format === 'regex' && String(issue.pattern ?? '').includes(ISO_DATE_PATTERN)) {
    return GERMAN_FORMATS.date!;
  }
  return GERMAN_FORMATS[issue.format] ?? 'Ungültiges Format.';
}

/** Auswahl mit leerer Alternative (`z.enum(…).or(z.literal(''))`) bleibt eine Auswahl. */
function germanInvalidUnion(issue: z.core.$ZodRawIssue<z.core.$ZodIssueInvalidUnion>): string {
  const onlyValues =
    issue.errors.length > 0 &&
    issue.errors.every(
      (branch) => branch.length > 0 && branch.every((nested) => nested.code === 'invalid_value'),
    );
  return onlyValues ? 'Ungültige Auswahl.' : 'Ungültige Eingabe.';
}

/** Zod-Fehlerkarte mit deutschen Feldmeldungen für Formulare und Action-Eingaben. */
export const germanFieldError: z.core.$ZodErrorMap = (issue) => {
  switch (issue.code) {
    case 'invalid_type':
      return germanInvalidType(issue);
    case 'too_small':
      return germanTooSmall(issue);
    case 'too_big':
      return germanTooBig(issue);
    case 'invalid_format':
      return germanInvalidFormat(issue);
    case 'not_multiple_of':
      return `Muss ein Vielfaches von ${num(issue.divisor)} sein.`;
    case 'invalid_value':
      return issue.values.length === 1 && issue.values[0] === true
        ? 'Bitte bestätigen.'
        : 'Ungültige Auswahl.';
    case 'unrecognized_keys':
      return 'Unbekannte Felder.';
    case 'invalid_union':
      return germanInvalidUnion(issue);
    default:
      return 'Ungültige Eingabe.';
  }
};

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
  const parsed = schema.safeParse(input, { error: germanFieldError });
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

  const parsed = schema.safeParse(input, { error: germanFieldError });
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
