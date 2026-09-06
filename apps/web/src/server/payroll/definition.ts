import { z } from 'zod';
import { validWorkflowCalendarDate } from '@/server/workflows/interaction-policy';
export type PayrollField = {
  key: string;
  label: string;
  type: 'text' | 'date' | 'number' | 'select' | 'textarea';
  required: boolean;
  options?: string[];
};
const f = (
  key: string,
  label: string,
  type: PayrollField['type'] = 'text',
  required = true,
  options?: string[],
): PayrollField => ({ key, label, type, required, ...(options ? { options } : {}) });
export const PAYROLL_SCHEMA = {
  version: 1,
  target: 'DATEV_LOHN_UND_GEHALT_NEW_EMPLOYEE',
  employer: [
    f('employmentStart', 'Beschäftigungsbeginn', 'date'),
    f('employmentEnd', 'Befristungsende (falls vereinbart)', 'date', false),
    f('jobTitle', 'Tätigkeit'),
    f('workplace', 'Beschäftigungsort'),
    f('employmentType', 'Beschäftigungsart', 'select', true, [
      'REGULAR',
      'MINIJOB',
      'TRAINING',
      'OTHER',
    ]),
    f('weeklyHours', 'Wochenstunden', 'number'),
    f('grossPay', 'Vereinbarte Bruttovergütung in EUR', 'number'),
    f('payBasis', 'Vergütungsbasis', 'select', true, ['MONTHLY', 'HOURLY']),
    f('specialAgreements', 'Weitere Vergütungs-/Beschäftigungsvereinbarungen', 'textarea', false),
    f(
      'immediateRegistrationHint',
      'Sofortmeldung: Hinweis des Arbeitgebers (Kanzlei prüft gesondert)',
      'select',
      true,
      ['UNKNOWN', 'POSSIBLY_REQUIRED', 'NOT_EXPECTED'],
    ),
  ],
  employee: [
    f('firstName', 'Vorname'),
    f('lastName', 'Nachname'),
    f('birthName', 'Geburtsname'),
    f('birthDate', 'Geburtsdatum', 'date'),
    f('birthPlace', 'Geburtsort'),
    f('birthCountry', 'Geburtsland'),
    f('nationality', 'Staatsangehörigkeit'),
    f('address', 'Straße, Hausnummer, Postleitzahl, Ort und Land', 'textarea'),
    f('email', 'E-Mail für Rückfragen'),
    f('taxIdState', 'Steuer-ID', 'select', true, ['ASSIGNED', 'NOT_ASSIGNED']),
    f('taxId', 'Steuer-ID (11 Ziffern, falls vergeben)', 'text', false),
    f('svState', 'Versicherungsnummer', 'select', true, ['ASSIGNED', 'NOT_ASSIGNED']),
    f('svNumber', 'Versicherungsnummer (falls vergeben)', 'text', false),
    f('insuranceKind', 'Krankenversicherung', 'select', true, ['STATUTORY', 'PRIVATE', 'UNCLEAR']),
    f('insuranceName', 'Name der Krankenversicherung'),
    f('iban', 'IBAN für die Vergütung'),
    f('accountHolder', 'Kontoinhaber'),
    f('mainEmployment', 'Hauptbeschäftigung', 'select', true, ['YES', 'NO', 'UNCLEAR']),
    f(
      'otherEmployment',
      'Weitere Beschäftigungen (Tätigkeit/Umfang, keine Diagnoseangaben)',
      'textarea',
      false,
    ),
  ],
};
export const DATEV_GATE_MESSAGE =
  'DATEV Lohn und Gehalt: Mitarbeiterneuanlage gesperrt. Die Feldspezifikation der installierten Version und ein dokumentierter Probeimport fehlen. Es wird keine vermeintlich importfähige ASCII-/CSV-Datei erzeugt.';
export const answerRecord = z.record(z.string(), z.string().max(4000));
export function validIban(raw: string): boolean {
  const value = raw.replace(/\s/g, '').toUpperCase();
  if (
    !/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(value) ||
    (value.startsWith('DE') && value.length !== 22)
  )
    return false;
  const digits = (value.slice(4) + value.slice(0, 4)).replace(/[A-Z]/g, (c) =>
    String(c.charCodeAt(0) - 55),
  );
  let remainder = 0;
  for (const c of digits) remainder = (remainder * 10 + Number(c)) % 97;
  return remainder === 1;
}
export function validSvNumber(raw: string): boolean {
  const value = raw.replace(/\s/g, '').toUpperCase();
  if (!/^\d{8}[A-Z]\d{3}$/.test(value)) return false;
  const digits =
    value.slice(0, 8) + String(value.charCodeAt(8) - 64).padStart(2, '0') + value.slice(9, 11);
  const factors = [2, 1, 2, 5, 7, 1, 2, 1, 2, 1, 2, 1];
  let sum = 0;
  for (let i = 0; i < digits.length; i++)
    sum += String(Number(digits[i]) * factors[i]!)
      .split('')
      .reduce((a, b) => a + Number(b), 0);
  return sum % 10 === Number(value[11]);
}

function validatePayrollField(field: PayrollField, value: string, submit: boolean): string[] {
  const errors: string[] = [];
  if (submit && field.required && !value) errors.push(field.label + ': erforderlich.');
  if (value && field.type === 'date' && !validWorkflowCalendarDate(value))
    errors.push(field.label + ': ungültiger Kalendertag.');
  if (value && field.options && !field.options.includes(value))
    errors.push(field.label + ': ungültige Auswahl.');
  if (
    value &&
    field.type === 'number' &&
    (!/^\d{1,8}([.,]\d{1,2})?$/.test(value) || Number(value.replace(',', '.')) <= 0)
  )
    errors.push(field.label + ': positive Zahl erforderlich.');
  return errors;
}

function validateEmployeeTaxAnswers(answers: Record<string, string>, submit: boolean): string[] {
  const errors: string[] = [];
  const tax = (answers.taxId ?? '').replace(/\s/g, '');
  if (tax && (!/^\d{11}$/.test(tax) || /^(\d)\1{10}$/.test(tax)))
    errors.push(
      'Steuer-ID: elf Ziffern erforderlich; Platzhalter sind unzulässig (Formatprüfung).',
    );
  if (submit && answers.taxIdState === 'ASSIGNED' && !tax)
    errors.push('Vergebene Steuer-ID eintragen.');
  if (answers.taxIdState === 'NOT_ASSIGNED' && tax)
    errors.push('Steuer-ID-Status und Nummer widersprechen sich.');
  return errors;
}

function validateEmployeeSocialInsuranceAnswers(
  answers: Record<string, string>,
  submit: boolean,
): string[] {
  const errors: string[] = [];
  if (answers.svNumber && !validSvNumber(answers.svNumber))
    errors.push('Versicherungsnummer: Aufbau oder Prüfziffer stimmen nicht.');
  if (submit && answers.svState === 'ASSIGNED' && !answers.svNumber)
    errors.push('Vergebene Versicherungsnummer eintragen.');
  if (answers.svState === 'NOT_ASSIGNED' && answers.svNumber)
    errors.push('Versicherungsnummer-Status und Nummer widersprechen sich.');
  return errors;
}

function validateEmployeeGeneralAnswers(answers: Record<string, string>): string[] {
  const errors: string[] = [];
  if (answers.iban && !validIban(answers.iban))
    errors.push('IBAN: Format oder Prüfziffer stimmen nicht.');
  if (
    answers.birthDate &&
    validWorkflowCalendarDate(answers.birthDate) &&
    answers.birthDate > new Date().toISOString().slice(0, 10)
  )
    errors.push('Geburtsdatum liegt in der Zukunft.');
  if (answers.email && !z.email().safeParse(answers.email).success)
    errors.push('E-Mail-Adresse prüfen.');
  return errors;
}

function validateEmployeeAnswers(answers: Record<string, string>, submit: boolean): string[] {
  return [
    ...validateEmployeeTaxAnswers(answers, submit),
    ...validateEmployeeSocialInsuranceAnswers(answers, submit),
    ...validateEmployeeGeneralAnswers(answers),
  ];
}

function validateEmployerAnswers(answers: Record<string, string>): string[] {
  return answers.employmentEnd &&
    answers.employmentStart &&
    answers.employmentEnd < answers.employmentStart
    ? ['Befristungsende liegt vor Beschäftigungsbeginn.']
    : [];
}

export function validatePayrollAnswers(
  side: 'employer' | 'employee',
  answers: Record<string, string>,
  submit: boolean,
  fields: PayrollField[],
): string[] {
  const errors: string[] = [];
  const known = new Set(fields.map((f) => f.key));
  if (Object.keys(answers).some((k) => !known.has(k))) errors.push('Unbekannte Felder.');
  for (const field of fields) {
    const value = (answers[field.key] ?? '').trim();
    errors.push(...validatePayrollField(field, value, submit));
  }
  errors.push(
    ...(side === 'employee'
      ? validateEmployeeAnswers(answers, submit)
      : validateEmployerAnswers(answers)),
  );
  return errors;
}
