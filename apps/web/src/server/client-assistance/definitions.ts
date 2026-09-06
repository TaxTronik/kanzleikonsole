import { z } from 'zod';

export const CASE_KINDS = ['BEWIRTUNG', 'EIGENBELEG', 'PROCEDURE'] as const;
export type CaseKind = (typeof CASE_KINDS)[number];
export interface CaseField {
  key: string;
  label: string;
  required?: boolean;
  type?: 'date' | 'text' | 'textarea' | 'money';
}
export const CASE_DEFINITIONS: Record<
  CaseKind,
  { title: string; version: number; fields: CaseField[] }
> = {
  BEWIRTUNG: {
    title: 'Bewirtungsergänzung',
    version: 1,
    fields: [
      { key: 'date', label: 'Tag der Bewirtung', type: 'date', required: true },
      { key: 'place', label: 'Ort / Bewirtungsbetrieb', required: true },
      { key: 'host', label: 'Bewirtende Person', required: true },
      {
        key: 'participants',
        label: 'Teilnehmer und Firmenzugehörigkeit (eine Person je Zeile)',
        type: 'textarea',
        required: true,
      },
      {
        key: 'occasion',
        label: 'Konkreter geschäftlicher Anlass',
        type: 'textarea',
        required: true,
      },
      { key: 'amount', label: 'Rechnungsbetrag in EUR', type: 'money', required: true },
      { key: 'tip', label: 'Zusätzlich gezahltes Trinkgeld in EUR', type: 'money' },
      {
        key: 'tipEvidence',
        label: 'Nachweis / Empfängerbestätigung zum Trinkgeld',
        type: 'textarea',
      },
    ],
  },
  EIGENBELEG: {
    title: 'Eigenbeleg',
    version: 1,
    fields: [
      { key: 'date', label: 'Tag des Geschäftsvorfalls', type: 'date', required: true },
      { key: 'recipient', label: 'Zahlungsempfänger', required: true },
      { key: 'amount', label: 'Betrag in EUR', type: 'money', required: true },
      {
        key: 'purpose',
        label: 'Geschäftsvorfall / Verwendungszweck',
        type: 'textarea',
        required: true,
      },
      {
        key: 'missingReason',
        label: 'Warum fehlt ein Fremdbeleg?',
        type: 'textarea',
        required: true,
      },
      { key: 'creator', label: 'Erstellende Person', required: true },
    ],
  },
  PROCEDURE: {
    title: 'Verfahrensdokumentation des Mandanten',
    version: 1,
    fields: [
      { key: 'effectiveFrom', label: 'Gültig ab', type: 'date', required: true },
      {
        key: 'organization',
        label: 'Unternehmen, Organisation und Verantwortlichkeiten',
        type: 'textarea',
        required: true,
      },
      { key: 'receiptOrigin', label: 'Belegentstehung und Belegeingang', type: 'textarea' },
      {
        key: 'cash',
        label: 'Kassensystem und Kassenführung (oder nicht anwendbar)',
        type: 'textarea',
      },
      { key: 'scanning', label: 'Scanverfahren und Erfassung', type: 'textarea' },
      {
        key: 'systems',
        label: 'Eingesetzte Systeme, Versionen und Schnittstellen',
        type: 'textarea',
      },
      { key: 'approval', label: 'Prüfung, Freigabe und belegte Kontrollen', type: 'textarea' },
      { key: 'storage', label: 'Ablage und Aufbewahrung', type: 'textarea' },
      { key: 'access', label: 'Zugriffsberechtigungen', type: 'textarea' },
      { key: 'backup', label: 'Datensicherung und Wiederherstellungsprüfung', type: 'textarea' },
      {
        key: 'changes',
        label: 'Änderungsverfahren und Änderungen gegenüber der Vorfassung',
        type: 'textarea',
      },
      { key: 'openQuestions', label: 'Offene Punkte / fehlende Nachweise', type: 'textarea' },
    ],
  },
};

export const caseInput = z.object({
  kind: z.enum(CASE_KINDS),
  answers: z.record(z.string(), z.string().max(12000)),
  confirmed: z.boolean(),
});
export function validateCaseAnswers(
  kind: CaseKind,
  answers: Record<string, string>,
  submit: boolean,
  confirmed: boolean,
  fields: CaseField[] = CASE_DEFINITIONS[kind].fields,
): string[] {
  const errors: string[] = [];
  for (const key of Object.keys(answers))
    if (!fields.some((f) => f.key === key)) errors.push('Unbekanntes Eingabefeld.');
  for (const field of fields) {
    const value = answers[field.key]?.trim() ?? '';
    if (submit && field.required && !value) errors.push(field.label + ' fehlt.');
    if (value && field.type === 'money' && !/^\d{1,10}([,.]\d{1,2})?$/.test(value))
      errors.push(field.label + ': ungültiger Betrag.');
    if (value && field.type === 'date') {
      const date = new Date(value + 'T00:00:00Z');
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(date.valueOf()) ||
        date.toISOString().slice(0, 10) !== value
      )
        errors.push(field.label + ': ungültiges Datum.');
    }
  }
  if (submit && !confirmed)
    errors.push('Bitte die Richtigkeit der Angaben ausdrücklich bestätigen.');
  return errors;
}
export function caseModule(kind: CaseKind) {
  return kind === 'PROCEDURE' ? 'clientProcedures' : 'expenseAssistance';
}
