import { describe, expect, it } from 'vitest';
import { formatTaxNumber, normalizeTaxNumber, TAX_STATES } from '../tax-registration';

// Independent examples from the state/federal structures published by ELSTER.
const cases = [
  ['BW', '12/345/67890', '2812034567890'],
  ['BY', '123/345/67890', '9123034567890'],
  ['BE', '12/345/67890', '1112034567890'],
  ['BB', '123/345/67890', '3123034567890'],
  ['HB', '12/345/67890', '2412034567890'],
  ['HH', '12/345/67890', '2212034567890'],
  ['HE', '012/345/67890', '2612034567890'],
  ['MV', '123/345/67890', '4123034567890'],
  ['NI', '12/345/67890', '2312034567890'],
  ['NW', '123/4567/8901', '5123045678901'],
  ['RP', '12/345/67890', '2712034567890'],
  ['SL', '123/345/67890', '1123034567890'],
  ['SN', '123/345/67890', '3123034567890'],
  ['ST', '123/345/67890', '3123034567890'],
  ['SH', '12/345/67890', '2112034567890'],
  ['TH', '123/345/67890', '4123034567890'],
] as const;

describe('TAX-MASTER-DATA-001 Steuernummern', () => {
  it.each(cases)(
    '%s converts state input and formats a federal number',
    (state, local, federal) => {
      expect(normalizeTaxNumber(local, state)).toBe(federal);
      expect(normalizeTaxNumber(` ${local.replaceAll('/', ' ')} `, state)).toBe(federal);
      expect(normalizeTaxNumber(federal, state)).toBe(federal);
      expect(normalizeTaxNumber(federal)).toBe(federal);
      expect(formatTaxNumber(federal, state)).toBe(local);
    },
  );
  it('covers all states', () =>
    expect(cases.map(([state]) => state)).toEqual(TAX_STATES.map(([state]) => state)));
  it.each([
    ['12/345/67890', ''],
    ['112/345/67890', 'HE'],
    ['12/345/6789', 'BW'],
    ['12/3456/7890', 'BW'],
    ['123/456/78901', 'NW'],
    ['12e34567890', 'BW'],
    ['2812134567890', 'BW'],
    ['2812034567890', 'BE'],
    ['12345678901', 'XX'],
  ])('rejects malformed or ambiguous %s / %s', (number, state) =>
    expect(() => normalizeTaxNumber(number, state)).toThrow(),
  );
});
