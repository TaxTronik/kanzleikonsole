import type { FormFieldType } from '@prisma/client';

export interface FormFieldForAnswerValidation {
  key: string;
  label: string;
  type: FormFieldType;
  required: boolean;
  minValue: string | null;
  maxValue: string | null;
  options: unknown;
}

export interface ValidatedFormAnswers {
  fileDocumentIds: string[];
  fileReferences: Array<{ fieldKey: string; documentId: string; fileName: string }>;
}

interface AnswerValidationOptions {
  requireRequired: boolean;
}

type PresentValueValidator = (
  field: FormFieldForAnswerValidation,
  value: unknown,
  options: AnswerValidationOptions,
) => string | null;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const PHONE_RE = /^[+()\d\s./-]+$/;

function invalid(field: FormFieldForAnswerValidation, detail: string): never {
  throw new Error(`Ungültiger Wert für „${field.label}": ${detail}`);
}

function isEmpty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0)
  );
}

function assertString(
  field: FormFieldForAnswerValidation,
  value: unknown,
  maxLength: number,
): asserts value is string {
  if (typeof value !== 'string') invalid(field, 'Text erwartet.');
  if (value.length > maxLength) invalid(field, `höchstens ${maxLength} Zeichen erlaubt.`);
}

function parseConfiguredNumber(
  field: FormFieldForAnswerValidation,
  raw: string | null,
  boundary: 'Minimum' | 'Maximum',
): number | null {
  if (raw === null || raw.trim() === '') return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Formularfeld „${field.label}" hat ein ungültiges ${boundary}.`);
  }
  return parsed;
}

function assertDate(field: FormFieldForAnswerValidation, value: unknown): asserts value is string {
  if (typeof value !== 'string') invalid(field, 'Datum im Format JJJJ-MM-TT erwartet.');
  const match = DATE_RE.exec(value);
  if (!match) invalid(field, 'Datum im Format JJJJ-MM-TT erwartet.');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    invalid(field, 'Kalenderdatum ist nicht gültig.');
  }
}

function optionValues(field: FormFieldForAnswerValidation): Set<string> {
  if (!Array.isArray(field.options)) {
    throw new Error(`Auswahlfeld „${field.label}" ist nicht vollständig konfiguriert.`);
  }
  const values = new Set<string>();
  for (const option of field.options) {
    if (
      !option ||
      typeof option !== 'object' ||
      typeof (option as Record<string, unknown>)['value'] !== 'string'
    ) {
      throw new Error(`Auswahlfeld „${field.label}" ist nicht vollständig konfiguriert.`);
    }
    values.add((option as { value: string }).value);
  }
  return values;
}

function validateTextValue(field: FormFieldForAnswerValidation, value: unknown): null {
  assertString(field, value, 5_000);
  return null;
}

function validateTextareaValue(field: FormFieldForAnswerValidation, value: unknown): null {
  assertString(field, value, 50_000);
  return null;
}

function validateEmailValue(field: FormFieldForAnswerValidation, value: unknown): null {
  assertString(field, value, 320);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    invalid(field, 'gültige E-Mail-Adresse erwartet.');
  }
  return null;
}

function validatePhoneValue(field: FormFieldForAnswerValidation, value: unknown): null {
  assertString(field, value, 50);
  if (value.length < 3 || !PHONE_RE.test(value) || !/\d/.test(value)) {
    invalid(field, 'gültige Telefonnummer erwartet.');
  }
  return null;
}

function validateNumericValue(field: FormFieldForAnswerValidation, value: unknown): null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalid(field, 'endliche Zahl erwartet.');
  }
  if (field.type === 'MONEY' && Math.abs(value * 100 - Math.round(value * 100)) > 1e-8) {
    invalid(field, 'höchstens zwei Nachkommastellen erlaubt.');
  }
  const min = parseConfiguredNumber(field, field.minValue, 'Minimum');
  const max = parseConfiguredNumber(field, field.maxValue, 'Maximum');
  if (min !== null && value < min) invalid(field, `Minimum ist ${field.minValue}.`);
  if (max !== null && value > max) invalid(field, `Maximum ist ${field.maxValue}.`);
  return null;
}

function validateDateValue(field: FormFieldForAnswerValidation, value: unknown): null {
  assertDate(field, value);
  if (field.minValue) {
    assertDate({ ...field, label: `${field.label} (Minimum)` }, field.minValue);
    if (value < field.minValue) invalid(field, `frühestes Datum ist ${field.minValue}.`);
  }
  if (field.maxValue) {
    assertDate({ ...field, label: `${field.label} (Maximum)` }, field.maxValue);
    if (value > field.maxValue) invalid(field, `spätestes Datum ist ${field.maxValue}.`);
  }
  return null;
}

function validateSelectValue(field: FormFieldForAnswerValidation, value: unknown): null {
  assertString(field, value, 500);
  if (!optionValues(field).has(value)) invalid(field, 'Option ist nicht freigegeben.');
  return null;
}

function validateMultiselectValue(field: FormFieldForAnswerValidation, value: unknown): null {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    invalid(field, 'Liste von Auswahlwerten erwartet.');
  }
  if (value.length > 100 || new Set(value).size !== value.length) {
    invalid(field, 'Auswahl enthält zu viele oder doppelte Werte.');
  }
  const allowed = optionValues(field);
  if (value.some((entry) => !allowed.has(entry))) {
    invalid(field, 'mindestens eine Option ist nicht freigegeben.');
  }
  return null;
}

function validateCheckboxValue(
  field: FormFieldForAnswerValidation,
  value: unknown,
  options: AnswerValidationOptions,
): null {
  if (typeof value !== 'boolean') invalid(field, 'Ja/Nein-Wert erwartet.');
  if (options.requireRequired && field.required && value !== true) {
    throw new Error(`Pflichtfeld nicht bestätigt: ${field.label}`);
  }
  return null;
}

function validateFileValue(field: FormFieldForAnswerValidation, value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid(field, 'Dateireferenz erwartet.');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== 'documentId' && key !== 'fileName') ||
    typeof record['documentId'] !== 'string' ||
    !UUID_RE.test(record['documentId']) ||
    typeof record['fileName'] !== 'string' ||
    record['fileName'].length < 1 ||
    record['fileName'].length > 200
  ) {
    invalid(field, 'Dateireferenz ist unvollständig.');
  }
  return record['documentId'];
}

const PRESENT_VALUE_VALIDATORS: Record<FormFieldType, PresentValueValidator> = {
  TEXT: validateTextValue,
  TEXTAREA: validateTextareaValue,
  EMAIL: validateEmailValue,
  PHONE: validatePhoneValue,
  NUMBER: validateNumericValue,
  MONEY: validateNumericValue,
  DATE: validateDateValue,
  SELECT: validateSelectValue,
  MULTISELECT: validateMultiselectValue,
  CHECKBOX: validateCheckboxValue,
  FILE: validateFileValue,
  INFO_TEXT: () => null,
};

/**
 * Vollständige serverseitige Prüfung der dynamischen Formularantworten.
 * Drafts dürfen leer/unvollständig sein, vorhandene Werte müssen aber bereits
 * typkorrekt sein. Beim Submit werden zusätzlich die Pflichtfelder erzwungen.
 */
export function validateFormAnswers(
  fields: readonly FormFieldForAnswerValidation[],
  answers: Record<string, unknown>,
  options: AnswerValidationOptions,
): ValidatedFormAnswers {
  const fieldsByKey = new Map(fields.map((field) => [field.key, field]));
  for (const key of Object.keys(answers)) {
    const field = fieldsByKey.get(key);
    if (!field || field.type === 'INFO_TEXT') {
      throw new Error(`Unbekanntes Formularfeld: ${key.slice(0, 60)}`);
    }
  }

  const fileDocumentIds: string[] = [];
  const fileReferences: Array<{ fieldKey: string; documentId: string; fileName: string }> = [];
  for (const field of fields) {
    if (field.type === 'INFO_TEXT') continue;
    const value = answers[field.key];
    if (isEmpty(value)) {
      if (options.requireRequired && field.required) {
        throw new Error(`Pflichtfeld nicht ausgefüllt: ${field.label}`);
      }
      continue;
    }

    const fileDocumentId = PRESENT_VALUE_VALIDATORS[field.type](field, value, options);
    if (fileDocumentId) {
      fileDocumentIds.push(fileDocumentId);
      fileReferences.push({
        fieldKey: field.key,
        documentId: fileDocumentId,
        fileName: (value as { fileName: string }).fileName,
      });
    }
  }
  return { fileDocumentIds: [...new Set(fileDocumentIds)], fileReferences };
}
