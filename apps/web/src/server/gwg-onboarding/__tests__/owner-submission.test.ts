import { describe, expect, it } from 'vitest';
import { GwgOnboardingOwnerSchema, toBeneficialOwnerSnapshot } from '../owner-submission';

const validOwner = {
  fullName: ' Erika Muster ',
  birthDate: '1980-02-03',
  birthPlace: 'Berlin',
  nationality: 'DE',
  street: 'Musterweg 1',
  postalCode: '10115',
  city: 'Berlin',
  countryIso: 'DE',
  sharePercent: '25,5 %',
  isPep: true,
  idNumber: 'L01X00T47',
  idIssuedBy: 'Stadt Berlin',
  idIssueDate: '2025-01-01',
  idExpiryDate: '2035-01-01',
  idFrontDocumentId: '11111111-1111-4111-8111-111111111111',
  idBackDocumentId: '22222222-2222-4222-8222-222222222222',
};

describe('öffentliches GwG-Onboarding – PEP-Snapshot', () => {
  it('verlangt eine ausdrückliche PEP-Angabe serverseitig', () => {
    const { isPep: _isPep, ...withoutPep } = validOwner;
    expect(GwgOnboardingOwnerSchema.safeParse(withoutPep).success).toBe(false);
  });

  it('übernimmt den PEP-Status in den gespeicherten Berechtigten-Snapshot', () => {
    const owner = GwgOnboardingOwnerSchema.parse(validOwner);
    expect(toBeneficialOwnerSnapshot(owner)).toMatchObject({
      fullName: 'Erika Muster',
      ownershipPct: 25.5,
      isPep: true,
    });
  });

  it('akzeptiert keine nur aus Leerraum bestehenden Pflichtangaben', () => {
    expect(GwgOnboardingOwnerSchema.safeParse({ ...validOwner, fullName: '   ' }).success).toBe(
      false,
    );
    expect(GwgOnboardingOwnerSchema.safeParse({ ...validOwner, idNumber: '   ' }).success).toBe(
      false,
    );
  });

  it('verlangt Land, Anteil und Ausstellungsdatum als Pflichtangaben', () => {
    expect(GwgOnboardingOwnerSchema.safeParse({ ...validOwner, countryIso: '' }).success).toBe(
      false,
    );
    expect(GwgOnboardingOwnerSchema.safeParse({ ...validOwner, sharePercent: '' }).success).toBe(
      false,
    );
    expect(GwgOnboardingOwnerSchema.safeParse({ ...validOwner, idIssueDate: '' }).success).toBe(
      false,
    );
    const { idIssueDate: _idIssueDate, ...withoutIssueDate } = validOwner;
    expect(GwgOnboardingOwnerSchema.safeParse(withoutIssueDate).success).toBe(false);
  });

  it('schreibt einen unplausiblen Anteil nicht in das Prozentfeld', () => {
    const owner = GwgOnboardingOwnerSchema.parse({ ...validOwner, sharePercent: '1000 %' });
    expect(toBeneficialOwnerSnapshot(owner)).toMatchObject({
      ownershipPct: null,
      notes: 'Anteil: 1000 %',
    });
  });

  it('blockiert zeitlich unmögliche Personen- und Ausweisdaten', () => {
    expect(
      GwgOnboardingOwnerSchema.safeParse({ ...validOwner, birthDate: '9999-01-01' }).success,
    ).toBe(false);
    expect(
      GwgOnboardingOwnerSchema.safeParse({ ...validOwner, idIssueDate: '9999-01-01' }).success,
    ).toBe(false);
    expect(
      GwgOnboardingOwnerSchema.safeParse({
        ...validOwner,
        idIssueDate: '2035-01-02',
        idExpiryDate: '2035-01-01',
      }).success,
    ).toBe(false);
    expect(
      GwgOnboardingOwnerSchema.safeParse({ ...validOwner, idIssueDate: '1979-12-31' }).success,
    ).toBe(false);
  });
});
