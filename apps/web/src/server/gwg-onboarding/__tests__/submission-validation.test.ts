import { describe, expect, it } from 'vitest';
import { fullIdentityViewport } from '@/lib/gwg/identity-viewport';

import {
  validateOnboardingSubmission,
  type OnboardingSubmissionOwner,
} from '../submission-validation';

function owner(overrides: Partial<OnboardingSubmissionOwner> = {}): OnboardingSubmissionOwner {
  return {
    localId: 'owner-1',
    fullName: 'Erika Muster',
    birthDate: '1980-01-01',
    birthPlace: 'Berlin',
    nationality: 'deutsch',
    street: 'Musterstraße 1',
    postalCode: '10115',
    city: 'Berlin',
    countryIso: 'DE',
    sharePercent: '100',
    isPep: false,
    idType: 'PERSONALAUSWEIS',
    idNumber: 'L01X00T47',
    idIssuedBy: 'Berlin',
    idIssueDate: '2020-01-01',
    idExpiryDate: '2030-01-01',
    idFrontDocumentId: '00000000-0000-4000-8000-000000000001',
    idBackDocumentId: '00000000-0000-4000-8000-000000000002',
    idFrontViewport: fullIdentityViewport('00000000-0000-4000-8000-000000000011', 'front'),
    idBackViewport: fullIdentityViewport('00000000-0000-4000-8000-000000000012', 'back'),
    ...overrides,
  };
}

describe('onboarding submission preflight', () => {
  it('accepts only invite-bound documents and returns linked dual roles', () => {
    const result = validateOnboardingSubmission({
      clientKind: 'JURPERS',
      uploadedDocumentIds: [
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000003',
        '00000000-0000-4000-8000-000000000004',
      ],
      existingCheckDocumentIds: [],
      owners: [owner()],
      representatives: [
        {
          localId: 'rep-1',
          fullName: 'Erika Muster',
          linkedOwnerLocalId: 'owner-1',
          idType: 'PERSONALAUSWEIS',
          idNumber: '',
          idIssuedBy: '',
          idIssueDate: '',
          idExpiryDate: '',
          idFrontDocumentId: null,
          idBackDocumentId: null,
        },
      ],
      extraDocuments: [
        {
          documentId: '00000000-0000-4000-8000-000000000003',
          type: 'HANDELSREGISTERAUSZUG',
        },
        {
          documentId: '00000000-0000-4000-8000-000000000004',
          type: 'TRANSPARENZREGISTER_AUSZUG',
        },
      ],
      legalEntity: { noRegisterEntry: false },
    });

    expect(result).toEqual({ ok: true, linkedOwnerLocalIds: ['owner-1'] });
  });

  it('fails closed for a document not uploaded through this invite', () => {
    const result = validateOnboardingSubmission({
      clientKind: 'NATPERS',
      uploadedDocumentIds: ['00000000-0000-4000-8000-000000000001'],
      existingCheckDocumentIds: [],
      owners: [owner()],
      representatives: [],
      extraDocuments: [],
      legalEntity: null,
    });

    expect(result).toEqual({
      ok: false,
      error: 'Referenziertes Dokument wurde nicht über diesen Onboarding-Link hochgeladen.',
    });
  });

  it('rejects a document assigned to more than one subject or purpose', () => {
    const duplicate = '00000000-0000-4000-8000-000000000001';
    const result = validateOnboardingSubmission({
      clientKind: 'NATPERS',
      uploadedDocumentIds: [duplicate],
      existingCheckDocumentIds: [],
      owners: [owner({ idFrontDocumentId: duplicate, idBackDocumentId: duplicate })],
      representatives: [],
      extraDocuments: [],
      legalEntity: null,
    });

    expect(result).toEqual({
      ok: false,
      error: 'Vorder- und Rückseite benötigen unterschiedliche Seiten oder Ausschnitte.',
    });
  });
  it('GWG-SELF-ONBOARDING-001 permits one PDF for one person but rejects sharing across people', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const version = '00000000-0000-4000-8000-000000000010';
    const person = owner({
      idFrontDocumentId: id,
      idBackDocumentId: id,
      idFrontViewport: fullIdentityViewport(version, 'front'),
      idBackViewport: { ...fullIdentityViewport(version, 'back'), page: 2 },
    });
    const input = {
      clientKind: 'NATPERS' as const,
      uploadedDocumentIds: [id],
      existingCheckDocumentIds: [],
      owners: [person],
      representatives: [],
      extraDocuments: [],
      legalEntity: null,
    };
    expect(validateOnboardingSubmission(input).ok).toBe(true);
    expect(
      validateOnboardingSubmission({ ...input, owners: [person, { ...person, localId: 'other' }] }),
    ).toMatchObject({ ok: false });
  });
});
