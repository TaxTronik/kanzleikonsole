// Fachkatalog: PAYROLL-INTAKE-001
import { describe, expect, it } from 'vitest';
import { PAYROLL_SCHEMA, validIban, validSvNumber, validatePayrollAnswers } from '../definition';

describe('PAYROLL-INTAKE-001 deliberately bounded plausibility', () => {
  it('permits incomplete drafts but requires a frozen historic field on submission', () => {
    expect(validatePayrollAnswers('employer', {}, false, PAYROLL_SCHEMA.employer)).toEqual([]);
    const historic = [
      { key: 'legacy', label: 'Historische Frage', type: 'text' as const, required: true },
    ];
    expect(validatePayrollAnswers('employer', { legacy: 'Alte Antwort' }, true, historic)).toEqual(
      [],
    );
    expect(validatePayrollAnswers('employer', {}, true, historic)).toEqual([
      'Historische Frage: erforderlich.',
    ]);
    expect(validatePayrollAnswers('employer', { grossPay: '100' }, false, historic)).toContain(
      'Unbekannte Felder.',
    );
  });
  it('rejects impossible dates, negative pay, unsupported choices and inverted employment dates', () => {
    const errors = validatePayrollAnswers(
      'employer',
      {
        employmentStart: '2026-02-30',
        employmentEnd: '2026-01-01',
        grossPay: '-1',
        employmentType: 'AUTOMATIC_CLASSIFICATION',
      },
      false,
      PAYROLL_SCHEMA.employer,
    );
    expect(errors).toHaveLength(4);
  });
  it('accepts explicit unassigned numbers without inventing identifiers', () => {
    const fields = PAYROLL_SCHEMA.employee.filter((f) =>
      ['taxIdState', 'taxId', 'svState', 'svNumber'].includes(f.key),
    );
    expect(
      validatePayrollAnswers(
        'employee',
        { taxIdState: 'NOT_ASSIGNED', svState: 'NOT_ASSIGNED' },
        true,
        fields,
      ),
    ).toEqual([]);
    expect(
      validatePayrollAnswers(
        'employee',
        { taxIdState: 'ASSIGNED', svState: 'ASSIGNED' },
        true,
        fields,
      ),
    ).toHaveLength(2);
    expect(
      validatePayrollAnswers(
        'employee',
        {
          taxIdState: 'NOT_ASSIGNED',
          taxId: '12345678901',
          svState: 'NOT_ASSIGNED',
          svNumber: '65170539J000',
        },
        true,
        fields,
      ),
    ).toHaveLength(2);
  });
  it('does not mistake repeated-digit placeholders for a tax ID and makes no allocation claim', () => {
    expect(
      validatePayrollAnswers(
        'employee',
        { taxId: '11111111111' },
        false,
        PAYROLL_SCHEMA.employee,
      )[0],
    ).toContain('Formatprüfung');
    expect(
      validatePayrollAnswers('employee', { taxId: '12345678901' }, false, PAYROLL_SCHEMA.employee),
    ).toEqual([]);
  });
  it('checks IBAN reordering and mod97, rejects a mutated checksum and a wrong German length', () => {
    expect(validIban('DE89 3704 0044 0532 0130 00')).toBe(true);
    expect(validIban('de89370400440532013000')).toBe(true);
    expect(validIban('GB82 WEST 1234 5698 7654 32')).toBe(true);
    expect(validIban('DE88370400440532013000')).toBe(false);
    expect(validIban('DE8937040044053201300')).toBe(false);
    expect(validIban('IBAN unbekannt')).toBe(false);
  });
  it('checks the VKVV letter substitution and weighted digit sums without claiming assignment', () => {
    // Synthetic arithmetic vector: 65 170539 J 00, weighted digit sum 50 -> checksum 0.
    expect(validSvNumber('65 170539 J 000')).toBe(true);
    expect(validSvNumber('65170539J001')).toBe(false);
    expect(validSvNumber('651705391000')).toBe(false);
    expect(validSvNumber('nicht vergeben')).toBe(false);
  });
});
