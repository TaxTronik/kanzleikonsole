import { describe, expect, it } from 'vitest';
import {
  gwgInviteDraftRevisionHash,
  type GwgInviteDraftRevisionSource,
} from '../invite-draft-revision';

function source(scanStatus: string, scanCompletedAt: Date | null): GwgInviteDraftRevisionSource {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    tenantId: '22222222-2222-4222-8222-222222222222',
    clientId: '33333333-3333-4333-8333-333333333333',
    status: 'DRAFT',
    changeScope: 'ROUTINE',
    predecessorCheckId: null,
    riskLevel: null,
    riskScore: null,
    riskBreakdown: null,
    riskAnswers: null,
    validUntil: null,
    verifiedAt: null,
    verifiedBy: null,
    rejectedReason: null,
    notes: null,
    legalForm: 'GbR',
    registerNumber: null,
    registerAuthority: null,
    noRegisterEntry: true,
    representativeNames: ['Rita Rolle'],
    ownershipStructureNotes: 'Direkt',
    identityAssignmentRequired: true,
    reviewSubmittedAt: null,
    reviewSubmittedBy: null,
    destroyedAt: null,
    createdAt: new Date('2026-07-16T00:00:00.000Z'),
    updatedAt: new Date('2026-07-16T00:00:00.000Z'),
    client: {
      id: '33333333-3333-4333-8333-333333333333',
      tenantId: '22222222-2222-4222-8222-222222222222',
      kind: 'PERSGES',
      name: 'Revision GbR',
      street: 'Musterweg 1',
      postalCode: '10115',
      city: 'Berlin',
      countryIso: 'DE',
      vatId: null,
    },
    beneficialOwners: [],
    representatives: [],
    idDocuments: [
      {
        id: '44444444-4444-4444-8444-444444444444',
        gwgCheckId: '11111111-1111-4111-8111-111111111111',
        documentSetId: '55555555-5555-4555-8555-555555555555',
        documentId: '66666666-6666-4666-8666-666666666666',
        type: 'GESELLSCHAFTSVERTRAG',
        ownerName: 'Revision GbR',
        number: null,
        issuedBy: null,
        issueDate: null,
        expiryDate: null,
        verifiedAt: null,
        naturalClientSubjectId: null,
        beneficialOwnerSubjectId: null,
        representativeSubjectId: null,
        identityAssignmentConfirmedAt: null,
        identityAssignmentConfirmedBy: null,
        notes: null,
        createdAt: new Date('2026-07-16T00:00:00.000Z'),
        updatedAt: new Date('2026-07-16T00:00:00.000Z'),
        document: {
          id: '66666666-6666-4666-8666-666666666666',
          title: 'Gesellschaftsvertrag.pdf',
          clientId: '33333333-3333-4333-8333-333333333333',
          classification: 'GWG_EVIDENCE',
          deletedAt: null,
          gwgDestructionRequestedAt: null,
          gwgDestroyedAt: null,
          versions: [
            {
              id: '77777777-7777-4777-8777-777777777777',
              versionNo: 1,
              sha256: Buffer.alloc(32, 7),
              sizeBytes: 123n,
              // Zusätzliche Prisma-Felder simulieren den erwartbaren
              // Scanner-Übergang; die Revision darf sie nicht einbeziehen.
              scanStatus,
              scanCompletedAt,
            },
          ],
        },
      },
    ],
  } as unknown as GwgInviteDraftRevisionSource;
}

describe('GwG-Invite-DRAFT-Revision', () => {
  it('bleibt bei PENDING → CLEAN derselben Dateiversion stabil', () => {
    const pending = source('PENDING', null);
    const clean = source('CLEAN', new Date('2026-07-16T12:00:00.000Z'));

    expect(gwgInviteDraftRevisionHash(clean)).toBe(gwgInviteDraftRevisionHash(pending));
  });

  it('ändert sich bei einer neuen stabilen Dateiversion oder Kanzleiänderung', () => {
    const initial = source('CLEAN', new Date());
    const newVersion = source('CLEAN', new Date());
    newVersion.idDocuments[0]!.document!.versions[0]!.id = '88888888-8888-4888-8888-888888888888';
    const editedClient = source('CLEAN', new Date());
    editedClient.client.countryIso = 'FR';

    expect(gwgInviteDraftRevisionHash(newVersion)).not.toBe(gwgInviteDraftRevisionHash(initial));
    expect(gwgInviteDraftRevisionHash(editedClient)).not.toBe(gwgInviteDraftRevisionHash(initial));
  });
});
