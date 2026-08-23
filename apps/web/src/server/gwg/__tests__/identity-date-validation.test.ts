import { describe, expect, it } from 'vitest';
import { validateIdentityDates } from '../identity-date-validation';

const now = new Date('2026-08-23T12:00:00.000Z');

describe('GwG-Identitätsdaten: zeitliche Plausibilität', () => {
  it('blockiert zukünftige Geburts- und Ausstellungsdaten', () => {
    expect(validateIdentityDates({ birthDate: '2026-08-24', now })).toContainEqual(
      expect.objectContaining({ field: 'birthDate' }),
    );
    expect(validateIdentityDates({ issueDate: '2026-08-24', now })).toContainEqual(
      expect.objectContaining({ field: 'issueDate' }),
    );
  });

  it('blockiert ein Ausstellungsdatum nach dem Gültigkeitsende', () => {
    expect(
      validateIdentityDates({ issueDate: '2025-01-02', expiryDate: '2025-01-01', now }),
    ).toContainEqual(expect.objectContaining({ field: 'expiryDate' }));
  });

  it('blockiert einen vor der Geburt ausgestellten oder abgelaufenen Ausweis', () => {
    expect(
      validateIdentityDates({
        birthDate: '1980-01-02',
        issueDate: '1979-12-31',
        expiryDate: '1990-01-01',
        now,
      }),
    ).toContainEqual(expect.objectContaining({ field: 'issueDate' }));
    expect(
      validateIdentityDates({ birthDate: '1980-01-02', expiryDate: '1979-12-31', now }),
    ).toContainEqual(expect.objectContaining({ field: 'expiryDate' }));
  });

  it('akzeptiert plausible historische Ausgabe und zukünftiges Gültigkeitsende', () => {
    expect(
      validateIdentityDates({
        birthDate: '1980-01-02',
        issueDate: '2025-01-01',
        expiryDate: '2035-01-01',
        now,
      }),
    ).toEqual([]);
  });
});
