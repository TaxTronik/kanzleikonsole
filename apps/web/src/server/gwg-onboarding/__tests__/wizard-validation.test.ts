import { describe, expect, it } from 'vitest';
import {
  onboardingLegalEntityStepError,
  onboardingOwnersStepError,
  onboardingRepresentativesStepError,
  type WizardOwnerInput,
} from '../wizard-validation';

function owner(overrides: Partial<WizardOwnerInput> = {}): WizardOwnerInput {
  return {
    id: 'owner-1',
    fullName: 'Ada Beispiel',
    birthDate: '1980-01-02',
    birthPlace: 'Berlin',
    nationality: 'DE',
    street: 'Testweg 1',
    postalCode: '10115',
    city: 'Berlin',
    countryIso: 'DE',
    sharePercent: '50',
    isPep: false,
    idType: 'PERSONALAUSWEIS',
    idNumber: 'ID-1',
    idIssuedBy: 'Berlin',
    idIssueDate: '2024-01-01',
    idExpiryDate: '2030-01-01',
    idFront: { documentId: '00000000-0000-4000-8000-000000000001' },
    idBack: { documentId: '00000000-0000-4000-8000-000000000002' },
    ...overrides,
  };
}

describe('wizard validation', () => {
  it('uses the submit owner schema for § 11 data', () => {
    expect(onboardingOwnersStepError([owner({ birthPlace: '' })])).toContain('Geburtsort');
    expect(onboardingOwnersStepError([owner()])).toBeNull();
  });

  it('requires an explicit representative role decision', () => {
    expect(
      onboardingRepresentativesStepError(
        'JURPERS',
        [owner()],
        [
          {
            id: 'rep-1',
            fullName: '',
            linkedOwnerId: undefined,
            idType: 'PERSONALAUSWEIS',
            idNumber: '',
            idIssuedBy: '',
            idIssueDate: '',
            idExpiryDate: '',
            idFront: null,
            idBack: null,
          },
        ],
      ),
    ).toContain('ausdrücklich');
  });

  it('shares the legal-entity evidence gate', () => {
    // Registerauszug reicht — der Transparenzregister-Auszug ist bewusst
    // optional (kostenpflichtig, holt die Kanzlei selbst).
    expect(
      onboardingLegalEntityStepError({
        clientKind: 'JURPERS',
        noRegisterEntry: false,
        evidenceTypes: ['HANDELSREGISTERAUSZUG'],
      }),
    ).toBeNull();
    expect(
      onboardingLegalEntityStepError({
        clientKind: 'JURPERS',
        noRegisterEntry: false,
        evidenceTypes: [],
      }),
    ).toContain('Registerauszug');
  });
});
