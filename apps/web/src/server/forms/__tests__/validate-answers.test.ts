import { describe, expect, it } from 'vitest';
import type { FormFieldType } from '@prisma/client';
import { validateFormAnswers, type FormFieldForAnswerValidation } from '../validate-answers';

function field(
  key: string,
  type: FormFieldType,
  overrides: Partial<FormFieldForAnswerValidation> = {},
): FormFieldForAnswerValidation {
  return {
    key,
    label: key,
    type,
    required: false,
    minValue: null,
    maxValue: null,
    options: null,
    ...overrides,
  };
}

describe('validateFormAnswers', () => {
  const fields = [
    field('text', 'TEXT'),
    field('textarea', 'TEXTAREA'),
    field('email', 'EMAIL'),
    field('phone', 'PHONE'),
    field('number', 'NUMBER', { minValue: '1', maxValue: '10' }),
    field('money', 'MONEY'),
    field('date', 'DATE', { minValue: '2026-01-01', maxValue: '2026-12-31' }),
    field('select', 'SELECT', { options: [{ value: 'a', label: 'A' }] }),
    field('multi', 'MULTISELECT', {
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    }),
    field('check', 'CHECKBOX', { required: true }),
    field('file', 'FILE'),
  ];

  it('akzeptiert typkorrekte Werte und sammelt geprüfte Dateireferenzen', () => {
    expect(
      validateFormAnswers(
        fields,
        {
          text: 'Text',
          textarea: 'Langtext',
          email: 'mara@example.de',
          phone: '+49 30 123456',
          number: 5,
          money: 12.34,
          date: '2026-08-23',
          select: 'a',
          multi: ['a', 'b'],
          check: true,
          file: {
            documentId: '11111111-1111-4111-8111-111111111111',
            fileName: 'beleg.pdf',
          },
        },
        { requireRequired: true },
      ),
    ).toEqual({
      fileDocumentIds: ['11111111-1111-4111-8111-111111111111'],
      fileReferences: [
        {
          fieldKey: 'file',
          documentId: '11111111-1111-4111-8111-111111111111',
          fileName: 'beleg.pdf',
        },
      ],
    });
  });

  it.each([
    ['email', 'keine-mail'],
    ['phone', 'abc'],
    ['number', 11],
    ['money', 12.345],
    ['date', '2026-02-30'],
    ['select', 'nicht-erlaubt'],
    ['multi', ['a', 'a']],
    ['check', 'true'],
    ['file', { documentId: 'keine-uuid', fileName: 'x.pdf' }],
  ])('weist fachlich ungültigen Wert für %s ab', (key, value) => {
    expect(() =>
      validateFormAnswers(
        fields,
        { check: true, [key as string]: value },
        { requireRequired: false },
      ),
    ).toThrow();
  });

  it('weist unbekannte Feldschlüssel ab', () => {
    expect(() =>
      validateFormAnswers(fields, { check: true, fremd: 'Wert' }, { requireRequired: false }),
    ).toThrow('Unbekanntes Formularfeld');
  });

  it('erlaubt im Draft leere optionale Werte, erzwingt beim Submit aber Bestätigungen', () => {
    expect(() =>
      validateFormAnswers(fields, { check: false }, { requireRequired: false }),
    ).not.toThrow();
    expect(() => validateFormAnswers(fields, { check: false }, { requireRequired: true })).toThrow(
      'Pflichtfeld nicht bestätigt',
    );
  });
});
