import { describe, expect, it } from 'vitest';
import { fullIdentityViewport } from '@/lib/gwg/identity-viewport';
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
  idFrontViewport: fullIdentityViewport('33333333-3333-4333-8333-333333333333', 'front'),
  idBackViewport: fullIdentityViewport('44444444-4444-4444-8444-444444444444', 'back'),
};

describe('öffentliches GwG-Onboarding – PEP-Snapshot', () => {
  it('GWG-SELF-ONBOARDING-001 requires both original versions even without OCR', () => {
    expect(
      GwgOnboardingOwnerSchema.safeParse({ ...validOwner, idFrontViewport: undefined }).success,
    ).toBe(false);
    expect(
      GwgOnboardingOwnerSchema.safeParse({ ...validOwner, idBackViewport: undefined }).success,
    ).toBe(false);
    expect(GwgOnboardingOwnerSchema.safeParse(validOwner).success).toBe(true);
  });
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
