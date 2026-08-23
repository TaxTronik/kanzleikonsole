import { berlinCalendarDate, startOfUtcDay } from '@taxtronik/tax';

export type IdentityDateField = 'birthDate' | 'issueDate' | 'expiryDate';

export interface IdentityDateIssue {
  field: IdentityDateField;
  message: string;
}

type DateInput = Date | string | null | undefined;

function dateOnly(value: DateInput): Date | null {
  if (!value) return null;
  const parsed =
    value instanceof Date
      ? value
      : /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? new Date(`${value}T00:00:00.000Z`)
        : new Date(value);
  return Number.isFinite(parsed.getTime()) ? startOfUtcDay(parsed) : null;
}

/**
 * Gemeinsame zeitliche Plausibilitätsprüfung für GwG-Personen und Ausweise.
 * Format-/Pflichtprüfung bleibt beim jeweiligen Eingabevertrag; hier werden
 * nur kalenderlogisch unmögliche, aber formal gültige Kombinationen gesperrt.
 */
export function validateIdentityDates(input: {
  birthDate?: DateInput;
  issueDate?: DateInput;
  expiryDate?: DateInput;
  now?: Date;
}): IdentityDateIssue[] {
  const birthDate = dateOnly(input.birthDate);
  const issueDate = dateOnly(input.issueDate);
  const expiryDate = dateOnly(input.expiryDate);
  const today = berlinCalendarDate(input.now ?? new Date());
  const issues: IdentityDateIssue[] = [];

  if (birthDate && birthDate > today) {
    issues.push({
      field: 'birthDate',
      message: 'Das Geburtsdatum darf nicht in der Zukunft liegen.',
    });
  }
  if (issueDate && issueDate > today) {
    issues.push({
      field: 'issueDate',
      message: 'Das Ausstellungsdatum darf nicht in der Zukunft liegen.',
    });
  }
  if (birthDate && issueDate && issueDate < birthDate) {
    issues.push({
      field: 'issueDate',
      message: 'Das Ausstellungsdatum darf nicht vor dem Geburtsdatum liegen.',
    });
  }
  if (issueDate && expiryDate && expiryDate < issueDate) {
    issues.push({
      field: 'expiryDate',
      message: 'Das Gültigkeitsdatum darf nicht vor dem Ausstellungsdatum liegen.',
    });
  } else if (birthDate && expiryDate && expiryDate < birthDate) {
    issues.push({
      field: 'expiryDate',
      message: 'Das Gültigkeitsdatum darf nicht vor dem Geburtsdatum liegen.',
    });
  }

  return issues;
}

export function firstIdentityDateError(input: Parameters<typeof validateIdentityDates>[0]) {
  return validateIdentityDates(input)[0]?.message ?? null;
}
