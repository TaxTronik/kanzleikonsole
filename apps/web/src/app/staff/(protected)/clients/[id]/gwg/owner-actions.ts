'use server';

import { z } from 'zod';
import { assertClientAccessTx } from '@/server/auth/rbac';
import { evidenceService } from '@/server/container';
import { lockGwgCheckLifecycleTx } from '@/server/gwg/reverification';
import { gwgBeneficialOwnerRevision } from '@/server/gwg/revisions';
import { withStaff, ActionError, parseFormData } from '@/server/actions/staff-action';

import {
  invalidatedIdentitySetRevisions,
  assertGwgEditable,
  claimCheckMutation,
  confirmUnchangedCheck,
  type ActionResult,
  type InvalidatedIdentitySet,
  type SavedBeneficialOwner,
} from './_action-helpers';

// Stabile Typ-Importpfade fuer die Form-Komponenten dieser Route.
export type { ActionResult, InvalidatedIdentitySet, SavedBeneficialOwner } from './_action-helpers';

const AddOwnerSchema = z.object({
  checkId: z.string().uuid(),
  clientId: z.string().uuid(),
  fullName: z.string().trim().min(1).max(200),
  birthDate: z.string().date(),
  birthPlace: z.string().trim().min(1).max(200),
  residence: z.string().trim().min(1).max(500),
  nationality: z.string().trim().min(1).max(100),
  ownershipPct: z.coerce.number().min(0).max(100).optional(),
  isPep: z.enum(['true', 'false']).transform((value) => value === 'true'),
});

export async function addBeneficialOwnerAction(
  _prev: { ok: boolean; error?: string } | null,
  formData: FormData,
) {
  const parsed = AddOwnerSchema.safeParse({
    checkId: formData.get('checkId'),
    clientId: formData.get('clientId'),
    fullName: formData.get('fullName'),
    birthDate: formData.get('birthDate') ?? '',
    birthPlace: formData.get('birthPlace') ?? '',
    residence: formData.get('residence') ?? '',
    nationality: formData.get('nationality') ?? '',
    ownershipPct: formData.get('ownershipPct') || undefined,
    isPep: formData.get('isPep'),
  });
  if (!parsed.success) return { ok: false as const, error: 'Validierungsfehler.' };
  const data = parsed.data;

  return withStaff(
    async (tx, { tenantId, staffId, session }) => {
      await assertClientAccessTx(tx, session, data.clientId);
      await lockGwgCheckLifecycleTx(tx, { tenantId, clientId: data.clientId });
      // Check laden + Status prüfen. Das Scope {id, clientId} bindet die checkId
      // an den autorisierten Mandanten (kein Cross-Check-Write über fremde ID).
      const check = await tx.gwgCheck.findFirst({
        where: { id: data.checkId, clientId: data.clientId },
        select: { status: true },
      });
      if (!check) throw new ActionError('GwG-Check nicht gefunden.');
      assertGwgEditable(check.status);
      await claimCheckMutation(tx, {
        checkId: data.checkId,
        clientId: data.clientId,
        expectedStatus: check.status,
        invalidateRisk: true,
      });
      const owner = await tx.gwgBeneficialOwner.create({
        data: {
          gwgCheckId: data.checkId,
          fullName: data.fullName,
          birthDate: data.birthDate ? new Date(data.birthDate) : null,
          birthPlace: data.birthPlace || null,
          residence: data.residence || null,
          nationality: data.nationality || null,
          ownershipPct: data.ownershipPct ?? null,
          isPep: data.isPep,
        },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'gwg.owner.add',
        resourceType: 'gwg_beneficial_owner',
        resourceId: owner.id,
        after: {
          fullName: data.fullName,
          ownershipPct: data.ownershipPct ?? null,
          isPep: data.isPep,
        },
      });
    },
    // Kein revalidate der aktuellen Route: das erzwang einen kompletten
    // RSC-Re-Render der GwG-Seite IN der Action-Antwort und ließ die
    // Form-Transition bis zur nächsten Interaktion hängen (UI "switcht"
    // erst nach erneutem Klick). Der Client ruft stattdessen nach dem
    // Erfolg router.refresh() außerhalb der Transition auf.
  );
}

const UpdateOwnerSchema = z.object({
  ownerId: z.string().uuid(),
  checkId: z.string().uuid(),
  clientId: z.string().uuid(),
  fullName: z.string().trim().min(1).max(200),
  birthDate: z.string().date(),
  birthPlace: z.string().trim().min(1).max(200),
  residence: z.string().trim().min(1).max(500),
  nationality: z.string().trim().min(1).max(100),
  ownershipPct: z.coerce.number().min(0).max(100).optional(),
  isPep: z.enum(['true', 'false']).transform((value) => value === 'true'),
  expectedRevision: z.string().min(2).max(20_000),
});

/**
 * Korrigiert die Angaben eines vorhandenen wirtschaftlich Berechtigten. Die
 * Check-Zeile wird zuerst per Status-CAS beansprucht; eine zeitgleiche Freigabe
 * gewinnt damit entweder vollstaendig oder wird sauber mit einem Konflikt
 * abgewiesen. Jede inhaltliche Korrektur nimmt eine laufende Freigabe zurueck.
 */
export async function updateBeneficialOwnerAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<
  ActionResult & {
    reviewReset?: boolean;
    revision?: string;
    saved?: SavedBeneficialOwner;
    invalidatedIdentitySets?: InvalidatedIdentitySet[];
  }
> {
  const parsed = UpdateOwnerSchema.safeParse({
    ownerId: formData.get('ownerId'),
    checkId: formData.get('checkId'),
    clientId: formData.get('clientId'),
    fullName: formData.get('fullName'),
    birthDate: formData.get('birthDate') ?? '',
    birthPlace: formData.get('birthPlace') ?? '',
    residence: formData.get('residence') ?? '',
    nationality: formData.get('nationality') ?? '',
    ownershipPct: formData.get('ownershipPct') || undefined,
    isPep: formData.get('isPep'),
    expectedRevision: formData.get('expectedRevision'),
  });
  if (!parsed.success) return { ok: false, error: 'Ungültige Angaben zur Person.' };
  const data = parsed.data;

  return withStaff(async (tx, { tenantId, staffId, session }) => {
    await assertClientAccessTx(tx, session, data.clientId);
    await lockGwgCheckLifecycleTx(tx, { tenantId, clientId: data.clientId });
    const check = await tx.gwgCheck.findFirst({
      where: { id: data.checkId, clientId: data.clientId },
      select: {
        status: true,
        beneficialOwners: {
          where: { id: data.ownerId },
          select: {
            id: true,
            fullName: true,
            birthDate: true,
            birthPlace: true,
            residence: true,
            nationality: true,
            ownershipPct: true,
            isPep: true,
          },
        },
        representatives: {
          select: { id: true, fullName: true, position: true, linkedBeneficialOwnerId: true },
          orderBy: [{ position: 'asc' }, { id: 'asc' }],
        },
      },
    });
    if (!check) throw new ActionError('GwG-Check nicht gefunden.');
    const owner = check.beneficialOwners[0];
    if (!owner) throw new ActionError('Wirtschaftlich Berechtigter nicht gefunden.');
    assertGwgEditable(check.status);
    if (gwgBeneficialOwnerRevision(owner) !== data.expectedRevision) {
      throw new ActionError(
        'Die Personendaten wurden zwischenzeitlich geändert. Bitte Seite neu laden; Ihre Eingabe wurde nicht überschrieben.',
      );
    }
    const identityFieldsChanged =
      owner.fullName !== data.fullName ||
      owner.birthDate?.toISOString().slice(0, 10) !== data.birthDate ||
      (owner.birthPlace ?? '') !== data.birthPlace ||
      (owner.residence ?? '') !== data.residence ||
      (owner.nationality ?? '') !== data.nationality;
    const ownershipBefore = owner.ownershipPct === null ? null : Number(owner.ownershipPct);
    const ownershipAfter = data.ownershipPct ?? null;
    const contentChanged =
      identityFieldsChanged || ownershipBefore !== ownershipAfter || owner.isPep !== data.isPep;

    if (!contentChanged) {
      await confirmUnchangedCheck(tx, {
        checkId: data.checkId,
        clientId: data.clientId,
        expectedStatus: check.status,
      });
      return {
        reviewReset: false,
        revision: gwgBeneficialOwnerRevision(owner),
        saved: {
          id: data.ownerId,
          fullName: data.fullName,
          birthDate: data.birthDate,
          birthPlace: data.birthPlace,
          residence: data.residence,
          nationality: data.nationality,
          ownershipPct: data.ownershipPct === undefined ? '' : String(data.ownershipPct),
          isPep: data.isPep,
        },
      };
    }

    await claimCheckMutation(tx, {
      checkId: data.checkId,
      clientId: data.clientId,
      expectedStatus: check.status,
      invalidateRisk: true,
    });
    const linkedRepresentatives = (check.representatives ?? []).filter(
      (representative) => representative.linkedBeneficialOwnerId === data.ownerId,
    );
    if (owner.fullName !== data.fullName && linkedRepresentatives.length > 0) {
      await tx.gwgRepresentative.updateMany({
        where: {
          gwgCheckId: data.checkId,
          linkedBeneficialOwnerId: data.ownerId,
        },
        data: { fullName: data.fullName },
      });
      await tx.gwgCheck.update({
        where: { id: data.checkId },
        data: {
          representativeNames: check.representatives.map((representative) =>
            representative.linkedBeneficialOwnerId === data.ownerId
              ? data.fullName
              : representative.fullName,
          ),
        },
      });
    }
    let invalidatedIdentityDocuments = 0;
    let invalidatedIdentityDocumentSetIds: string[] = [];
    if (identityFieldsChanged) {
      const linkedRepresentativeIds = linkedRepresentatives.map(
        (representative) => representative.id,
      );
      const assignedDocuments = await tx.gwgIdDocument.findMany({
        where: {
          gwgCheckId: data.checkId,
          OR: [
            { beneficialOwnerSubjectId: data.ownerId },
            ...(linkedRepresentativeIds.length > 0
              ? [{ representativeSubjectId: { in: linkedRepresentativeIds } }]
              : []),
          ],
        },
        select: { id: true, documentSetId: true },
      });
      const invalidated = await tx.gwgIdDocument.updateMany({
        where: {
          gwgCheckId: data.checkId,
          id: { in: assignedDocuments.map((document) => document.id) },
        },
        data: {
          identityAssignmentConfirmedAt: null,
          identityAssignmentConfirmedBy: null,
          verifiedAt: null,
        },
      });
      invalidatedIdentityDocuments = invalidated.count;
      invalidatedIdentityDocumentSetIds = assignedDocuments.map(
        (document) => document.documentSetId,
      );
    }
    await tx.gwgBeneficialOwner.update({
      where: { id: data.ownerId },
      data: {
        fullName: data.fullName,
        birthDate: data.birthDate ? new Date(data.birthDate) : null,
        birthPlace: data.birthPlace || null,
        residence: data.residence || null,
        nationality: data.nationality || null,
        ownershipPct: data.ownershipPct ?? null,
        isPep: data.isPep,
      },
    });
    const invalidatedIdentitySets = await invalidatedIdentitySetRevisions(
      tx,
      data.checkId,
      invalidatedIdentityDocumentSetIds,
    );
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'gwg.owner.update',
      resourceType: 'gwg_beneficial_owner',
      resourceId: data.ownerId,
      before: {
        fullName: owner.fullName,
        birthDate: owner.birthDate?.toISOString().slice(0, 10) ?? null,
        birthPlace: owner.birthPlace,
        residence: owner.residence,
        nationality: owner.nationality,
        ownershipPct: owner.ownershipPct?.toString() ?? null,
        isPep: owner.isPep,
      },
      after: {
        fullName: data.fullName,
        birthDate: data.birthDate || null,
        birthPlace: data.birthPlace || null,
        residence: data.residence || null,
        nationality: data.nationality || null,
        ownershipPct: data.ownershipPct ?? null,
        isPep: data.isPep,
        invalidatedIdentityDocuments,
      },
    });
    return {
      reviewReset: check.status === 'IN_REVIEW',
      ...(invalidatedIdentitySets.length > 0 ? { invalidatedIdentitySets } : {}),
      revision: gwgBeneficialOwnerRevision({
        id: data.ownerId,
        fullName: data.fullName,
        birthDate: data.birthDate,
        birthPlace: data.birthPlace || null,
        residence: data.residence || null,
        nationality: data.nationality || null,
        ownershipPct: data.ownershipPct ?? null,
        isPep: data.isPep,
      }),
      saved: {
        id: data.ownerId,
        fullName: data.fullName,
        birthDate: data.birthDate,
        birthPlace: data.birthPlace,
        residence: data.residence,
        nationality: data.nationality,
        ownershipPct: data.ownershipPct === undefined ? '' : String(data.ownershipPct),
        isPep: data.isPep,
      },
    };
  });
}

const RemoveOwnerSchema = z.object({
  ownerId: z.string().uuid(),
  checkId: z.string().uuid(),
  clientId: z.string().uuid(),
  expectedRevision: z.string().min(2).max(20_000),
});

/**
 * Entfernt eine nicht mehr wirtschaftlich berechtigte Person nur aus dem
 * aktuellen, bearbeitbaren Snapshot. Zugehörige Ausweisbelege bleiben in der
 * Akte erhalten, werden aber bewusst entbestätigt und müssen einer aktuellen
 * Person neu zugeordnet werden. Der alte VERIFIED-Snapshot bleibt unverändert.
 */
export async function removeBeneficialOwnerAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<
  ActionResult & {
    removedOwnerId?: string;
    reviewReset?: boolean;
    invalidatedIdentitySets?: InvalidatedIdentitySet[];
  }
> {
  const parsed = parseFormData(RemoveOwnerSchema, formData);
  if (!parsed.ok) return { ok: false, error: 'Ungültige Angaben zur Person.' };
  const data = parsed.data;

  return withStaff(async (tx, { tenantId, staffId, session }) => {
    await assertClientAccessTx(tx, session, data.clientId);
    await lockGwgCheckLifecycleTx(tx, { tenantId, clientId: data.clientId });
    const check = await tx.gwgCheck.findFirst({
      where: { id: data.checkId, clientId: data.clientId },
      select: {
        status: true,
        representatives: {
          where: { linkedBeneficialOwnerId: data.ownerId },
          select: { id: true },
        },
        beneficialOwners: {
          where: { id: data.ownerId },
          select: {
            id: true,
            fullName: true,
            birthDate: true,
            birthPlace: true,
            residence: true,
            nationality: true,
            ownershipPct: true,
            isPep: true,
          },
        },
      },
    });
    if (!check) throw new ActionError('GwG-Check nicht gefunden.');
    assertGwgEditable(check.status);
    const owner = check.beneficialOwners[0];
    if (!owner) throw new ActionError('Wirtschaftlich Berechtigter nicht gefunden.');
    if (gwgBeneficialOwnerRevision(owner) !== data.expectedRevision) {
      throw new ActionError(
        'Die Personendaten wurden zwischenzeitlich geändert. Bitte Seite neu laden.',
      );
    }

    await claimCheckMutation(tx, {
      checkId: data.checkId,
      clientId: data.clientId,
      expectedStatus: check.status,
      invalidateRisk: true,
    });
    const linkedRepresentativeIds = check.representatives.map(
      (representative) => representative.id,
    );
    const affectedDocuments = await tx.gwgIdDocument.findMany({
      where: {
        gwgCheckId: data.checkId,
        OR: [
          { beneficialOwnerSubjectId: data.ownerId },
          ...(linkedRepresentativeIds.length > 0
            ? [{ representativeSubjectId: { in: linkedRepresentativeIds } }]
            : []),
        ],
      },
      select: {
        id: true,
        documentSetId: true,
        beneficialOwnerSubjectId: true,
      },
    });
    const directlyAssignedDocumentIds = affectedDocuments
      .filter((document) => document.beneficialOwnerSubjectId === data.ownerId)
      .map((document) => document.id);
    if (directlyAssignedDocumentIds.length > 0) {
      await tx.gwgIdDocument.updateMany({
        where: {
          gwgCheckId: data.checkId,
          id: { in: directlyAssignedDocumentIds },
        },
        data: {
          beneficialOwnerSubjectId: null,
          identityAssignmentConfirmedAt: null,
          identityAssignmentConfirmedBy: null,
          verifiedAt: null,
        },
      });
    }
    const unlinkedRepresentativeRoles = await tx.gwgRepresentative.updateMany({
      where: {
        gwgCheckId: data.checkId,
        linkedBeneficialOwnerId: data.ownerId,
      },
      data: { linkedBeneficialOwnerId: null },
    });
    const removed = await tx.gwgBeneficialOwner.deleteMany({
      where: { id: data.ownerId, gwgCheckId: data.checkId },
    });
    if (removed.count !== 1) {
      throw new ActionError('Die Person wurde parallel geändert. Bitte Seite neu laden.');
    }
    const invalidatedIdentitySets = await invalidatedIdentitySetRevisions(
      tx,
      data.checkId,
      affectedDocuments.map((document) => document.documentSetId),
    );
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'gwg.owner.remove',
      resourceType: 'gwg_beneficial_owner',
      resourceId: data.ownerId,
      before: {
        fullName: owner.fullName,
        birthDate: owner.birthDate?.toISOString().slice(0, 10) ?? null,
        birthPlace: owner.birthPlace,
        residence: owner.residence,
        nationality: owner.nationality,
        ownershipPct: owner.ownershipPct?.toString() ?? null,
        isPep: owner.isPep,
      },
      after: {
        removedFromCurrentSnapshot: true,
        invalidatedIdentityDocuments: affectedDocuments.length,
        unlinkedRepresentativeRoles: unlinkedRepresentativeRoles.count,
      },
    });
    return {
      removedOwnerId: data.ownerId,
      reviewReset: check.status === 'IN_REVIEW',
      ...(invalidatedIdentitySets.length > 0 ? { invalidatedIdentitySets } : {}),
    };
  });
}
