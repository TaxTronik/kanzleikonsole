import { describe, expect, it, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';
import {
  syncGwgRepresentativesTx,
  type GwgRepresentativeState,
  type SubmittedGwgRepresentative,
} from '../representatives';

const CHECK_ID = '11111111-1111-4111-8111-111111111111';
const REP_A = '22222222-2222-4222-8222-222222222222';
const REP_B = '33333333-3333-4333-8333-333333333333';
const REP_NEW = '44444444-4444-4444-8444-444444444444';
const OWNER_A = '55555555-5555-4555-8555-555555555555';
const OWNER_B = '66666666-6666-4666-8666-666666666666';

function current(
  id: string,
  fullName: string,
  position: number,
  linkedBeneficialOwnerId: string | null,
): GwgRepresentativeState {
  return { id, fullName, position, linkedBeneficialOwnerId };
}

function submitted(state: GwgRepresentativeState, isNew = false): SubmittedGwgRepresentative {
  return { ...state, isNew };
}

function makeTx(documents: Array<{ id: string; documentSetId: string }> = []) {
  return {
    $executeRaw: vi.fn().mockResolvedValue(1),
    gwgIdDocument: {
      findMany: vi.fn().mockResolvedValue(documents),
      updateMany: vi.fn().mockResolvedValue({ count: documents.length }),
    },
    gwgRepresentative: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

describe('syncGwgRepresentativesTx', () => {
  it('schreibt Positions- und Owner-Link-Swaps zweiphasig und invalidiert Identitaeten', async () => {
    const tx = makeTx([
      { id: 'document-a', documentSetId: 'set-a' },
      { id: 'document-b', documentSetId: 'set-b' },
    ]);
    const before = [
      current(REP_A, 'Anna Alt', 0, OWNER_A),
      current(REP_B, 'Berta Alt', 1, OWNER_B),
    ];
    const after = [
      submitted(current(REP_B, 'Berta Neu', 0, OWNER_A)),
      submitted(current(REP_A, 'Anna Neu', 1, OWNER_B)),
    ];

    const result = await syncGwgRepresentativesTx(tx as unknown as TxClient, {
      checkId: CHECK_ID,
      currentRepresentatives: before,
      submittedRepresentatives: after,
    });

    expect(tx.gwgIdDocument.findMany).toHaveBeenCalledWith({
      where: { gwgCheckId: CHECK_ID, representativeSubjectId: { in: [REP_A, REP_B] } },
      select: { id: true, documentSetId: true },
    });
    expect(tx.gwgIdDocument.updateMany).toHaveBeenCalledWith({
      where: { gwgCheckId: CHECK_ID, id: { in: ['document-a', 'document-b'] } },
      data: {
        representativeSubjectId: null,
        identityAssignmentConfirmedAt: null,
        identityAssignmentConfirmedBy: null,
        verifiedAt: null,
      },
    });
    expect(tx.gwgRepresentative.updateMany).toHaveBeenNthCalledWith(1, {
      where: { gwgCheckId: CHECK_ID, id: { in: [REP_B, REP_A] } },
      data: { position: { increment: 10_000 } },
    });
    expect(tx.gwgRepresentative.updateMany).toHaveBeenNthCalledWith(2, {
      where: { gwgCheckId: CHECK_ID, id: { in: [REP_B, REP_A] } },
      data: { linkedBeneficialOwnerId: null },
    });
    expect(tx.gwgRepresentative.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.gwgRepresentative.updateMany.mock.invocationCallOrder[1]!,
    );
    expect(tx.gwgRepresentative.updateMany.mock.invocationCallOrder[1]).toBeLessThan(
      tx.$executeRaw.mock.invocationCallOrder[0]!,
    );
    const query = tx.$executeRaw.mock.calls[0]![0] as { sql: string; values: unknown[] };
    expect(query.sql).toContain('UPDATE "gwg_representative" AS representative');
    expect(query.sql).toContain('representative."gwg_check_id" = ?::uuid');
    expect(query.values).toContain(CHECK_ID);
    expect(result).toEqual({
      invalidatedIdentityDocuments: 2,
      invalidatedIdentityDocumentSetIds: ['set-a', 'set-b'],
    });
  });

  it('loescht entfernte und erzeugt neue Vertreter ohne unnoetigen Positions-Shift', async () => {
    const tx = makeTx();
    const retained = current(REP_A, 'Anna', 0, null);

    await syncGwgRepresentativesTx(tx as unknown as TxClient, {
      checkId: CHECK_ID,
      currentRepresentatives: [retained, current(REP_B, 'Berta', 1, null)],
      submittedRepresentatives: [
        submitted(retained),
        submitted(current(REP_NEW, 'Clara', 1, OWNER_A), true),
      ],
    });

    expect(tx.gwgRepresentative.deleteMany).toHaveBeenCalledWith({
      where: { gwgCheckId: CHECK_ID, id: { in: [REP_B] } },
    });
    expect(tx.gwgRepresentative.updateMany).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.gwgRepresentative.createMany).toHaveBeenCalledWith({
      data: [
        {
          id: REP_NEW,
          gwgCheckId: CHECK_ID,
          fullName: 'Clara',
          position: 1,
          linkedBeneficialOwnerId: OWNER_A,
        },
      ],
    });
  });

  it('fuehrt bei identischem Snapshot keine Schreiboperation aus', async () => {
    const tx = makeTx();
    const representative = current(REP_A, 'Anna', 0, OWNER_A);

    const result = await syncGwgRepresentativesTx(tx as unknown as TxClient, {
      checkId: CHECK_ID,
      currentRepresentatives: [representative],
      submittedRepresentatives: [submitted(representative)],
    });

    expect(tx.gwgIdDocument.findMany).not.toHaveBeenCalled();
    expect(tx.gwgIdDocument.updateMany).not.toHaveBeenCalled();
    expect(tx.gwgRepresentative.deleteMany).not.toHaveBeenCalled();
    expect(tx.gwgRepresentative.updateMany).not.toHaveBeenCalled();
    expect(tx.gwgRepresentative.createMany).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(result).toEqual({
      invalidatedIdentityDocuments: 0,
      invalidatedIdentityDocumentSetIds: [],
    });
  });
});
