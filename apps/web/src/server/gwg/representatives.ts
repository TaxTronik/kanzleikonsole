import { Prisma } from '@prisma/client';
import type { TxClient } from '@taxtronik/db';

export interface GwgRepresentativeState {
  id: string;
  fullName: string;
  position: number;
  linkedBeneficialOwnerId: string | null;
}

export interface SubmittedGwgRepresentative extends GwgRepresentativeState {
  isNew: boolean;
}

export interface SyncGwgRepresentativesResult {
  invalidatedIdentityDocuments: number;
  invalidatedIdentityDocumentSetIds: string[];
}

/**
 * Synchronisiert den stabil identifizierten Vertreter-Snapshot innerhalb der
 * bereits vom Aufrufer geoeffneten GwG-Transaktion. Der Check-CAS muss vor
 * diesem Helfer erfolgt sein; Evidence wird danach vom Aufrufer geschrieben.
 */
export async function syncGwgRepresentativesTx(
  tx: TxClient,
  input: {
    checkId: string;
    currentRepresentatives: GwgRepresentativeState[];
    submittedRepresentatives: SubmittedGwgRepresentative[];
  },
): Promise<SyncGwgRepresentativesResult> {
  const currentById = new Map(
    input.currentRepresentatives.map((representative) => [representative.id, representative]),
  );
  const submittedById = new Map(
    input.submittedRepresentatives.map((representative) => [representative.id, representative]),
  );
  const changedIdentityIds = input.currentRepresentatives
    .filter((representative) => {
      const submitted = submittedById.get(representative.id);
      return (
        !submitted ||
        submitted.fullName !== representative.fullName ||
        submitted.linkedBeneficialOwnerId !== (representative.linkedBeneficialOwnerId ?? null)
      );
    })
    .map((representative) => representative.id);

  let invalidatedIdentityDocuments = 0;
  let invalidatedIdentityDocumentSetIds: string[] = [];
  if (changedIdentityIds.length > 0) {
    const assignedDocuments = await tx.gwgIdDocument.findMany({
      where: {
        gwgCheckId: input.checkId,
        representativeSubjectId: { in: changedIdentityIds },
      },
      select: { id: true, documentSetId: true },
    });
    const invalidated = await tx.gwgIdDocument.updateMany({
      where: {
        gwgCheckId: input.checkId,
        id: { in: assignedDocuments.map((document) => document.id) },
      },
      data: {
        representativeSubjectId: null,
        identityAssignmentConfirmedAt: null,
        identityAssignmentConfirmedBy: null,
        verifiedAt: null,
      },
    });
    invalidatedIdentityDocuments = invalidated.count;
    invalidatedIdentityDocumentSetIds = assignedDocuments.map((document) => document.documentSetId);
  }

  const retainedIds = input.submittedRepresentatives
    .filter((representative) => !representative.isNew)
    .map((representative) => representative.id);
  const retainedIdSet = new Set(retainedIds);
  const removedIds = input.currentRepresentatives
    .filter((representative) => !retainedIdSet.has(representative.id))
    .map((representative) => representative.id);
  if (removedIds.length > 0) {
    await tx.gwgRepresentative.deleteMany({
      where: { gwgCheckId: input.checkId, id: { in: removedIds } },
    });
  }

  const retainedWithChangedPosition = input.submittedRepresentatives.filter(
    (representative) =>
      !representative.isNew &&
      currentById.get(representative.id)?.position !== representative.position,
  );
  if (retainedWithChangedPosition.length > 0) {
    // Erst aus dem Unique-Zielbereich schieben, damit Positions-Swaps nicht
    // transient gegen (gwg_check_id, position) verstossen.
    await tx.gwgRepresentative.updateMany({
      where: { gwgCheckId: input.checkId, id: { in: retainedIds } },
      data: { position: { increment: 10_000 } },
    });
  }

  const retainedToUpdate = input.submittedRepresentatives.filter((entry) => {
    const current = currentById.get(entry.id);
    return (
      !entry.isNew &&
      (retainedWithChangedPosition.length > 0 ||
        current?.fullName !== entry.fullName ||
        (current?.linkedBeneficialOwnerId ?? null) !== entry.linkedBeneficialOwnerId)
    );
  });
  if (retainedToUpdate.length > 0) {
    const changedOwnerLinkIds = retainedToUpdate
      .filter(
        (representative) =>
          (currentById.get(representative.id)?.linkedBeneficialOwnerId ?? null) !==
          representative.linkedBeneficialOwnerId,
      )
      .map((representative) => representative.id);
    if (changedOwnerLinkIds.length > 0) {
      // Der Unique-Index auf (check, linked owner) ist nicht deferrable. Ein
      // Link-Swap wird deshalb zweiphasig NULL -> Ziel geschrieben.
      await tx.gwgRepresentative.updateMany({
        where: { gwgCheckId: input.checkId, id: { in: changedOwnerLinkIds } },
        data: { linkedBeneficialOwnerId: null },
      });
    }
    await tx.$executeRaw(
      Prisma.sql`
        UPDATE "gwg_representative" AS representative
           SET "full_name" = changed.full_name,
               "position" = changed.position,
               "linked_beneficial_owner_id" = changed.linked_beneficial_owner_id,
               "updated_at" = CURRENT_TIMESTAMP
          FROM (
            VALUES ${Prisma.join(
              retainedToUpdate.map(
                (representative) =>
                  Prisma.sql`(${representative.id}::uuid, ${representative.fullName}::text, ${representative.position}::integer, ${representative.linkedBeneficialOwnerId}::uuid)`,
              ),
            )}
          ) AS changed(id, full_name, position, linked_beneficial_owner_id)
         WHERE representative."id" = changed.id
           AND representative."gwg_check_id" = ${input.checkId}::uuid
      `,
    );
  }

  const newRepresentatives = input.submittedRepresentatives.filter((entry) => entry.isNew);
  if (newRepresentatives.length > 0) {
    await tx.gwgRepresentative.createMany({
      data: newRepresentatives.map((representative) => ({
        id: representative.id,
        gwgCheckId: input.checkId,
        fullName: representative.fullName,
        position: representative.position,
        linkedBeneficialOwnerId: representative.linkedBeneficialOwnerId,
      })),
    });
  }

  return { invalidatedIdentityDocuments, invalidatedIdentityDocumentSetIds };
}
