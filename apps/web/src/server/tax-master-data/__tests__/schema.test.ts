import { describe, expect, it } from 'vitest';
import { TaxMasterDataSchema } from '../schema';
const row = {
  label: 'Einkommensteuer',
  stateCode: 'BE',
  number: '12/345/67890',
  taxOfficeName: 'Finanzamt Beispiel',
  isPrimary: true,
};
describe('TAX-MASTER-DATA-001 tax proposal validation', () => {
  it('allows multiple registrations with one primary', () =>
    expect(
      TaxMasterDataSchema.safeParse({
        vatId: '',
        registrations: [
          row,
          { ...row, label: 'Betrieb', number: '13/345/67890', isPrimary: false },
        ],
      }).success,
    ).toBe(true));
  it('allows VAT-only clients and no tax registrations', () =>
    expect(TaxMasterDataSchema.safeParse({ vatId: 'DE123456789', registrations: [] }).success).toBe(
      true,
    ));
  it('rejects duplicate normalized numbers and conflicting primary choices', () => {
    expect(
      TaxMasterDataSchema.safeParse({
        vatId: '',
        registrations: [row, { ...row, number: '1112034567890', isPrimary: false }],
      }).success,
    ).toBe(false);
    expect(
      TaxMasterDataSchema.safeParse({
        vatId: '',
        registrations: [row, { ...row, number: '13/345/67890' }],
      }).success,
    ).toBe(false);
    expect(
      TaxMasterDataSchema.safeParse({ vatId: '', registrations: [{ ...row, isPrimary: false }] })
        .success,
    ).toBe(false);
  });
});
