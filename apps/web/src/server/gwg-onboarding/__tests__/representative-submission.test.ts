import { describe, expect, it } from 'vitest';
import {
  GwgOnboardingRepresentativeSchema,
  onboardingRepresentativeRoleError,
} from '../representative-submission';

const DOCUMENT_FRONT = '11111111-1111-4111-8111-111111111111';
const DOCUMENT_BACK = '22222222-2222-4222-8222-222222222222';

function separateRepresentative() {
  return {
    localId: 'representative-1',
    fullName: 'Rita Rolle',
    linkedOwnerLocalId: null,
    idNumber: 'ID-1',
    idIssuedBy: 'Berlin',
    idIssueDate: '2020-01-01',
    idExpiryDate: '2030-01-01',
    idFrontDocumentId: DOCUMENT_FRONT,
    idBackDocumentId: DOCUMENT_BACK,
  };
}

describe('öffentliche GwG-Vertretererfassung', () => {
  it('verlangt für eine separate Vertretung einen vollständigen Ausweissatz', () => {
    expect(
      GwgOnboardingRepresentativeSchema.safeParse({
        ...separateRepresentative(),
        idFrontDocumentId: null,
      }).success,
    ).toBe(false);
    expect(GwgOnboardingRepresentativeSchema.safeParse(separateRepresentative()).success).toBe(
      true,
    );
  });

  it('verlangt bei expliziter Doppelrolle keinen zweiten Ausweis', () => {
    const result = GwgOnboardingRepresentativeSchema.safeParse({
      localId: 'representative-1',
      fullName: 'Rita Rolle',
      linkedOwnerLocalId: 'owner-1',
      idNumber: '',
      idIssuedBy: '',
      idIssueDate: '',
      idExpiryDate: '',
      idFrontDocumentId: null,
      idBackDocumentId: null,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(
      onboardingRepresentativeRoleError('PERSGES', new Set(['owner-1']), [result.data]),
    ).toBeNull();
  });

  it('weist unbekannte und doppelt verknüpfte Owner-IDs zurück', () => {
    const first = GwgOnboardingRepresentativeSchema.parse({
      ...separateRepresentative(),
      linkedOwnerLocalId: 'owner-1',
      idFrontDocumentId: null,
      idBackDocumentId: null,
    });
    const second = { ...first, localId: 'representative-2' };
    expect(onboardingRepresentativeRoleError('PERSGES', new Set(), [first])).toContain(
      'verweist nicht',
    );
    expect(
      onboardingRepresentativeRoleError('PERSGES', new Set(['owner-1']), [first, second]),
    ).toContain('nur einmal');
  });
});
