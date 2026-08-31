import { describe, expect, it } from 'vitest';
import { gwgProfessionalReviewSnapshotHash } from '../review-snapshot';

function snapshot() {
  return {
    id: 'check-1',
    clientId: 'client-1',
    client: {
      id: 'client-1',
      kind: 'PERSGES',
      name: 'Koxha GbR',
      street: 'Teststraße 1',
      postalCode: '10115',
      city: 'Berlin',
      countryIso: 'DE',
      vatId: null,
    },
    changeScope: 'BOTH',
    predecessorCheckId: 'check-0',
    status: 'IN_REVIEW',
    riskLevel: 'LOW',
    riskScore: 1,
    riskAnswers: { pep: 0 },
    riskBreakdown: { pep: 0 },
    notes: 'Geprüft',
    legalForm: 'GbR',
    registerNumber: null,
    registerAuthority: null,
    noRegisterEntry: true,
    representativeNames: ['Rey Koxha'],
    representatives: [{ id: 'rep-1', fullName: 'Rey Koxha', position: 0 }],
    ownershipStructureNotes: '50 Prozent',
    beneficialOwners: [
      {
        id: 'owner-1',
        fullName: 'Rey Koxha',
        birthDate: new Date('1990-01-01T00:00:00.000Z'),
        birthPlace: 'Berlin',
        residence: 'Berlin',
        nationality: 'deutsch',
        ownershipPct: { toString: () => '50' },
        isPep: false,
        notes: null,
      },
    ],
    idDocuments: [
      {
        id: 'id-1',
        documentSetId: 'set-1',
        documentId: 'document-1',
        type: 'PERSONALAUSWEIS',
        ownerName: 'Rey Koxha',
        number: 'ABC123',
        issuedBy: 'Berlin',
        issueDate: new Date('2025-01-01T00:00:00.000Z'),
        expiryDate: new Date('2035-01-01T00:00:00.000Z'),
        verifiedAt: new Date('2026-07-16T08:00:00.000Z'),
        naturalClientSubjectId: null,
        beneficialOwnerSubjectId: null,
        representativeSubjectId: 'rep-1',
        identityAssignmentConfirmedAt: new Date('2026-07-16T08:00:00.000Z'),
        identityAssignmentConfirmedBy: 'staff-1',
        notes: 'Original gesehen',
        document: {
          id: 'document-1',
          clientId: 'client-1',
          classification: 'GWG_EVIDENCE',
          deletedAt: null,
          gwgDestructionRequestedAt: null,
          gwgDestroyedAt: null,
          versions: [
            { scanStatus: 'CLEAN', scanCompletedAt: new Date('2026-07-16T07:00:00.000Z') },
          ],
        },
      },
    ],
    reviewSubmittedAt: new Date('2026-07-16T09:00:00.000Z'),
    reviewSubmittedBy: 'staff-2',
  };
}

describe('GwG-Berufsträger-Snapshot', () => {
  it('GWG-REVERIFICATION-VALIDITY-001: USt-ID ist nicht Teil der v2-Prüfgrundlage', () => {
    const source = snapshot();
    expect(
      gwgProfessionalReviewSnapshotHash({
        ...source,
        client: { ...source.client, vatId: 'DE999999999' },
      }),
    ).toBe(gwgProfessionalReviewSnapshotHash(source));
  });
  it('GWG-RISK-REVIEW-001: eine geänderte Ansicht bindet eine neue Bestätigung', () => {
    const source = snapshot();
    const cropped = {
      ...source,
      idDocuments: source.idDocuments.map((document) => ({
        ...document,
        viewports: {
          front: { page: 1, rotation: 90, crop: { x: 0.1, y: 0.2, width: 0.8, height: 0.6 } },
        },
      })),
    };
    expect(gwgProfessionalReviewSnapshotHash(cropped)).not.toBe(
      gwgProfessionalReviewSnapshotHash(source),
    );
  });
  it('ist stabil und reagiert auf jede haftungsrelevante Änderung', () => {
    const source = snapshot();
    const first = gwgProfessionalReviewSnapshotHash(source);
    const second = gwgProfessionalReviewSnapshotHash({
      ...source,
      representatives: [...source.representatives].reverse(),
      beneficialOwners: [...source.beneficialOwners].reverse(),
      idDocuments: [...source.idDocuments].reverse(),
    });
    const changed = gwgProfessionalReviewSnapshotHash({
      ...source,
      beneficialOwners: [{ ...source.beneficialOwners[0]!, ownershipPct: 51 }],
    });
    const changedClient = gwgProfessionalReviewSnapshotHash({
      ...source,
      client: { ...source.client, kind: 'JURPERS', name: 'Koxha GmbH' },
    });
    const changedScope = gwgProfessionalReviewSnapshotHash({
      ...source,
      changeScope: 'REPRESENTATIVES',
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    expect(changed).not.toBe(first);
    expect(changedClient).not.toBe(first);
    expect(changedScope).not.toBe(first);
  });
});
