import { describe, it, expect } from 'vitest';
import { freezeFormSchema, readFormSchema } from '../schema-snapshot';
import { validateFormAnswers } from '../validate-answers';
const template = {
  name: 'Inventur',
  description: null,
  introMd: null,
  fields: [
    {
      id: 'field',
      key: 'inventory',
      label: 'Inventurliste vorhanden',
      type: 'CHECKBOX' as const,
      required: true,
      options: null,
      helpText: null,
      defaultValue: null,
      minValue: null,
      maxValue: null,
    },
  ],
};
describe('FORM-SCHEMA-SNAPSHOT-001', () => {
  it('keeps original labels and validation when the template changes', () => {
    const frozen = freezeFormSchema(template);
    const changed = {
      ...template,
      fields: [{ ...template.fields[0]!, label: 'Neue Frage', key: 'different', required: false }],
    };
    const loaded = readFormSchema(frozen, changed);
    expect(loaded.fields[0]?.label).toBe('Inventurliste vorhanden');
    expect(() =>
      validateFormAnswers(loaded.fields, { inventory: false }, { requireRequired: true }),
    ).toThrow();
    expect(() =>
      validateFormAnswers(loaded.fields, { inventory: true }, { requireRequired: true }),
    ).not.toThrow();
  });
  it('does not fabricate an earlier schema for legacy rows', () => {
    expect(readFormSchema(null, template)).toBe(template);
  });
  it('fails closed for invalid snapshots instead of switching to a mutable template', () => {
    expect(() => readFormSchema({ version: 2, fields: [] }, template)).toThrow();
  });
  it('does not mutate frozen fields through later changes of the source object', () => {
    const input = structuredClone(template);
    const frozen = freezeFormSchema(input);
    input.fields[0]!.label = 'verändert';
    expect(frozen.fields[0]?.label).toBe('Inventurliste vorhanden');
  });
});
// Fachkatalog: FORM-SCHEMA-SNAPSHOT-001
// Fachkatalog: YEAR-END-CAMPAIGN-001
