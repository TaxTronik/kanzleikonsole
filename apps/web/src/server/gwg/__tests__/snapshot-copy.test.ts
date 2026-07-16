import { describe, expect, it, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';
import { copyGwgSnapshotTx, type GwgSnapshotCopySource } from '../reverification';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = '22222222-2222-4222-8222-222222222222';
const TARGET_CHECK_ID = '33333333-3333-4333-8333-333333333333';
const OWNER_ID = '44444444-4444-4444-8444-444444444444';

function source(overrides: Partial<GwgSnapshotCopySource> = {}): GwgSnapshotCopySource {
  return {
    destroyedAt: null,
    notes: 'Unveraenderliche Altakte',
    legalForm: 'GmbH',
    registerNumber: 'HRB 42',
    registerAuthority: 'AG Berlin',
    noRegisterEntry: false,
    representativeNames: ['Rita Rolle'],
    ownershipStructureNotes: 'Direkte Beteiligung',
    beneficialOwners: [
      {
        id: OWNER_ID,
        fullName: 'Erika Eigentum',
        birthDate: new Date('1980-01-01T00:00:00.000Z'),
        birthPlace: 'Berlin',
        residence: 'Berlin',
        nationality: 'DE',
        ownershipPct: null,
        isPep: false,
        notes: null,
      },
    ],
    representatives: [
      {
        id: '66666666-6666-4666-8666-666666666666',
        fullName: 'Rita Rolle',
        position: 0,
        linkedBeneficialOwnerId: OWNER_ID,
      },
    ],
    idDocuments: [],
    ...overrides,
  };
}

function makeTx() {
  return {
    gwgCheck: { update: vi.fn().mockResolvedValue({ id: TARGET_CHECK_ID }) },
    gwgBeneficialOwner: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    gwgRepresentative: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    gwgIdDocument: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
}

describe('copyGwgSnapshotTx', () => {
  it('kopiert nur die Identifizierungsgrundlage mit neuen Owner- und Dokumentset-IDs', async () => {
    const tx = makeTx();
    const front = {
      documentSetId: '77777777-7777-4777-8777-777777777777',
      documentId: '88888888-8888-4888-8888-888888888888',
      type: 'PERSONALAUSWEIS' as const,
      ownerName: 'Rita Rolle',
      number: 'L01X00T47',
      issuedBy: 'Berlin',
      issueDate: new Date('2020-01-01T00:00:00.000Z'),
      expiryDate: new Date('2030-01-01T00:00:00.000Z'),
      notes: null,
      document: {
        id: '88888888-8888-4888-8888-888888888888',
        tenantId: TENANT_ID,
        clientId: CLIENT_ID,
        classification: 'GWG_EVIDENCE' as const,
        deletedAt: null,
        gwgDestructionRequestedAt: null,
        gwgDestroyedAt: null,
      },
    };
    const back = {
      ...front,
      documentId: '99999999-9999-4999-8999-999999999999',
      document: { ...front.document, id: '99999999-9999-4999-8999-999999999999' },
    };
    const foreignEvidence = {
      ...front,
      documentSetId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      documentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      document: {
        ...front.document,
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        tenantId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      },
    };

    const result = await copyGwgSnapshotTx(tx as unknown as TxClient, {
      tenantId: TENANT_ID,
      clientId: CLIENT_ID,
      targetCheckId: TARGET_CHECK_ID,
      source: source({ idDocuments: [front, back, foreignEvidence] }),
    });

    expect(tx.gwgCheck.update).toHaveBeenCalledWith({
      where: { id: TARGET_CHECK_ID },
      data: {
        notes: 'Unveraenderliche Altakte',
        legalForm: 'GmbH',
        registerNumber: 'HRB 42',
        registerAuthority: 'AG Berlin',
        noRegisterEntry: false,
        representativeNames: ['Rita Rolle'],
        ownershipStructureNotes: 'Direkte Beteiligung',
      },
    });
    const copiedOwner = tx.gwgBeneficialOwner.createMany.mock.calls[0]![0].data[0]!;
    expect(copiedOwner).toMatchObject({
      gwgCheckId: TARGET_CHECK_ID,
      fullName: 'Erika Eigentum',
    });
    expect(copiedOwner.id).not.toBe(OWNER_ID);
    const copiedRepresentative = tx.gwgRepresentative.createMany.mock.calls[0]![0].data[0]!;
    expect(copiedRepresentative.linkedBeneficialOwnerId).toBe(copiedOwner.id);
    const copiedDocuments = tx.gwgIdDocument.createMany.mock.calls[0]![0].data as Array<{
      documentSetId: string;
      documentId: string | null;
      [key: string]: unknown;
    }>;
    expect(copiedDocuments[0]!.documentSetId).toBe(copiedDocuments[1]!.documentSetId);
    expect(copiedDocuments[0]!.documentSetId).not.toBe(front.documentSetId);
    expect(copiedDocuments[2]!.documentSetId).not.toBe(foreignEvidence.documentSetId);
    expect(copiedDocuments.map((document) => document.documentId)).toEqual([
      front.documentId,
      back.documentId,
      null,
    ]);
    expect(copiedDocuments[0]).not.toHaveProperty('verifiedAt');
    expect(copiedDocuments[0]).not.toHaveProperty('representativeSubjectId');
    expect(tx.gwgCheck.update.mock.invocationCallOrder[0]).toBeLessThan(
      tx.gwgBeneficialOwner.createMany.mock.invocationCallOrder[0]!,
    );
    expect(result).toEqual({
      copiedOwnerCount: 1,
      copiedDocumentCount: 3,
      copiedLinkedDocumentCount: 2,
    });
  });

  it('materialisiert einen vernichteten Snapshot nicht erneut', async () => {
    const tx = makeTx();

    const result = await copyGwgSnapshotTx(tx as unknown as TxClient, {
      tenantId: TENANT_ID,
      clientId: CLIENT_ID,
      targetCheckId: TARGET_CHECK_ID,
      source: source({ destroyedAt: new Date('2026-07-16T10:00:00.000Z') }),
    });

    expect(tx.gwgCheck.update).not.toHaveBeenCalled();
    expect(tx.gwgBeneficialOwner.createMany).not.toHaveBeenCalled();
    expect(tx.gwgRepresentative.createMany).not.toHaveBeenCalled();
    expect(tx.gwgIdDocument.createMany).not.toHaveBeenCalled();
    expect(result).toEqual({
      copiedOwnerCount: 0,
      copiedDocumentCount: 0,
      copiedLinkedDocumentCount: 0,
    });
  });
});
