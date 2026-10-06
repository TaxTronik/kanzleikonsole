// =============================================================================
// Wirtschaftlich Berechtigte einer GwG-Prüfung: Doppelrolle ergänzen,
// korrigieren und aus dem aktuellen Snapshot entfernen (Review-Befund K-03,
// vormals Callbacks in app/staff/(protected)/clients/[id]/gwg/owner-actions.ts).
//
// Fachkatalog: GWG-BENEFICIAL-OWNERS-001, GWG-REPRESENTATIVE-AUTHORITY-001,
// GWG-IDENTIFICATION-EVIDENCE-001. Reihenfolge der Prüfungen, Schreibzugriffe
// und Audit-Ereignisse entspricht unverändert der früheren Action.
// =============================================================================

import type { GwgBeneficialOwner } from '@prisma/client';
import type { TxClient } from '@taxtronik/db';
import { ActionError } from '@/server/actions/action-error';
import { evidenceService } from '@/server/container';
import { withEditableGwgCheckTx, type GwgStaffActor } from './editable-check';
import {
  invalidatedIdentitySetRevisions,
  type InvalidatedIdentitySet,
} from './invalidated-identity-sets';
import { assertLegalEntityClientKind } from './persons';
import { gwgBeneficialOwnerRevision } from './revisions';

export interface SavedBeneficialOwner {
  id: string;
  fullName: string;
  birthDate: string;
  birthPlace: string;
  residence: string;
  nationality: string;
  ownershipPct: string;
  isPep: boolean;
}

const OWNER_SNAPSHOT_SELECT = {
  id: true,
  fullName: true,
  birthDate: true,
  birthPlace: true,
  residence: true,
  nationality: true,
  ownershipPct: true,
  isPep: true,
} as const;

type StoredOwnerSnapshot = Pick<
  GwgBeneficialOwner,
  | 'id'
  | 'fullName'
  | 'birthDate'
  | 'birthPlace'
  | 'residence'
  | 'nationality'
  | 'ownershipPct'
  | 'isPep'
>;

function requireBeneficialOwner<T>(owners: T[]): T {
  const owner = owners[0];
  if (!owner) throw new ActionError('Wirtschaftlich Berechtigter nicht gefunden.');
  return owner;
}

// --- Doppelrolle ergänzen ---------------------------------------------------

export interface BeneficialOwnerRoleInput {
  representativeId: string;
  checkId: string;
  clientId: string;
  ownershipPct?: number;
}

interface RepresentativeGeneralData {
  birthDate: Date | null;
  birthPlace: string | null;
  residence: string | null;
  nationality: string | null;
  isPep: boolean | null;
}

function assertRepresentativeGeneralDataComplete<T extends RepresentativeGeneralData>(
  representative: T,
): asserts representative is T & { isPep: boolean } {
  if (
    !representative.birthDate ||
    !representative.birthPlace?.trim() ||
    !representative.residence?.trim() ||
    !representative.nationality?.trim() ||
    representative.isPep === null
  ) {
    throw new ActionError('Bitte zuerst die allgemeinen Angaben der Person vollständig erfassen.');
  }
}

/**
 * Ergänzt eine bereits erfasste gesetzliche Vertretung um die Rolle als
 * wirtschaftlich Berechtigter. Owner-Datensatz und explizite Rollenverknüpfung
 * entstehen in derselben Transaktion; der Vertreter bleibt dabei erhalten.
 */
export async function addBeneficialOwnerRoleTx(
  tx: TxClient,
  input: BeneficialOwnerRoleInput,
  actor: GwgStaffActor,
): Promise<{ createdOwnerId: string; reviewReset: boolean }> {
  return withEditableGwgCheckTx(
    tx,
    actor,
    {
      clientId: input.clientId,
      checkId: input.checkId,
      select: {
        status: true,
        client: { select: { kind: true } },
        representatives: {
          where: { id: input.representativeId },
          select: {
            id: true,
            personAnchorId: true,
            fullName: true,
            birthDate: true,
            birthPlace: true,
            residence: true,
            nationality: true,
            isPep: true,
            linkedBeneficialOwnerId: true,
          },
        },
      },
      beforeEditable: (check) =>
        assertLegalEntityClientKind(
          check.client.kind,
          'Doppelrollen sind nur bei Rechtsträgern vorgesehen.',
        ),
    },
    async (check, mutation) => {
      const representative = check.representatives[0];
      if (!representative) {
        throw new ActionError('Die gesetzliche Vertretung wurde nicht gefunden.');
      }
      if (representative.linkedBeneficialOwnerId) {
        throw new ActionError('Diese Person ist bereits wirtschaftlich berechtigt.');
      }
      assertRepresentativeGeneralDataComplete(representative);

      await mutation.claim({ invalidateRisk: true });
      const owner = await tx.gwgBeneficialOwner.create({
        data: {
          gwgCheckId: input.checkId,
          fullName: representative.fullName,
          personAnchorId: representative.personAnchorId,
          birthDate: representative.birthDate,
          birthPlace: representative.birthPlace,
          residence: representative.residence,
          nationality: representative.nationality,
          ownershipPct: input.ownershipPct ?? null,
          isPep: representative.isPep,
        },
        select: { id: true },
      });
      const linked = await tx.gwgRepresentative.updateMany({
        where: {
          id: input.representativeId,
          gwgCheckId: input.checkId,
          linkedBeneficialOwnerId: null,
        },
        data: { linkedBeneficialOwnerId: owner.id },
      });
      if (linked.count !== 1) {
        throw new ActionError('Die Rollen wurden parallel geändert. Bitte Seite neu laden.');
      }

      await evidenceService.record(tx, {
        tenantId: actor.tenantId,
        actorType: 'STAFF',
        actorId: actor.staffId,
        action: 'gwg.person.roles.update',
        resourceType: 'gwg_person',
        resourceId: input.representativeId,
        before: { roles: ['VERTRETUNGSBERECHTIGT'] },
        after: {
          beneficialOwnerId: owner.id,
          roles: ['VERTRETUNGSBERECHTIGT', 'WIRTSCHAFTLICH_BERECHTIGT'],
          ownershipPct: input.ownershipPct ?? null,
          isPep: representative.isPep,
        },
      });
      return {
        createdOwnerId: owner.id,
        reviewReset: check.status === 'IN_REVIEW',
      };
    },
  );
}

// --- Korrektur --------------------------------------------------------------

export interface BeneficialOwnerUpdateInput {
  ownerId: string;
  checkId: string;
  clientId: string;
  fullName: string;
  birthDate: string;
  birthPlace: string;
  residence: string;
  nationality: string;
  ownershipPct?: number;
  isPep: boolean;
  expectedRevision: string;
}

// GWG-BENEFICIAL-OWNERS-001 / GWG-IDENTIFICATION-EVIDENCE-001: these pure
// comparisons/mappings leave the transaction, CAS, synchronization and audit
// sequence of the service unchanged.
function ownerIdentityFieldsChanged(
  owner: StoredOwnerSnapshot,
  data: BeneficialOwnerUpdateInput,
): boolean {
  return (
    owner.fullName !== data.fullName ||
    owner.birthDate?.toISOString().slice(0, 10) !== data.birthDate ||
    (owner.birthPlace ?? '') !== data.birthPlace ||
    (owner.residence ?? '') !== data.residence ||
    (owner.nationality ?? '') !== data.nationality
  );
}

function savedBeneficialOwner(data: BeneficialOwnerUpdateInput): SavedBeneficialOwner {
  return {
    id: data.ownerId,
    fullName: data.fullName,
    birthDate: data.birthDate,
    birthPlace: data.birthPlace,
    residence: data.residence,
    nationality: data.nationality,
    ownershipPct: data.ownershipPct === undefined ? '' : String(data.ownershipPct),
    isPep: data.isPep,
  };
}

function updatedOwnerColumns(data: BeneficialOwnerUpdateInput) {
  return {
    fullName: data.fullName,
    birthDate: data.birthDate ? new Date(data.birthDate) : null,
    birthPlace: data.birthPlace || null,
    residence: data.residence || null,
    nationality: data.nationality || null,
    ownershipPct: data.ownershipPct ?? null,
    isPep: data.isPep,
  };
}

function ownerAuditBefore(owner: StoredOwnerSnapshot) {
  return {
    fullName: owner.fullName,
    birthDate: owner.birthDate?.toISOString().slice(0, 10) ?? null,
    birthPlace: owner.birthPlace,
    residence: owner.residence,
    nationality: owner.nationality,
    ownershipPct: owner.ownershipPct?.toString() ?? null,
    isPep: owner.isPep,
  };
}

function ownerAuditAfter(data: BeneficialOwnerUpdateInput, invalidatedIdentityDocuments: number) {
  return {
    fullName: data.fullName,
    birthDate: data.birthDate || null,
    birthPlace: data.birthPlace || null,
    residence: data.residence || null,
    nationality: data.nationality || null,
    ownershipPct: data.ownershipPct ?? null,
    isPep: data.isPep,
    invalidatedIdentityDocuments,
  };
}

function updatedOwnerRevision(data: BeneficialOwnerUpdateInput): string {
  return gwgBeneficialOwnerRevision({
    id: data.ownerId,
    fullName: data.fullName,
    birthDate: data.birthDate,
    birthPlace: data.birthPlace || null,
    residence: data.residence || null,
    nationality: data.nationality || null,
    ownershipPct: data.ownershipPct ?? null,
    isPep: data.isPep,
  });
}

interface CheckRepresentativeRow {
  id: string;
  fullName: string;
  linkedBeneficialOwnerId: string | null;
}

/** Hält die verknüpfte Vertreterrolle (Doppelrolle) und die Namensliste synchron. */
async function synchronizeLinkedRepresentativesTx(
  tx: TxClient,
  data: BeneficialOwnerUpdateInput,
  owner: StoredOwnerSnapshot,
  representatives: CheckRepresentativeRow[],
  linkedRepresentatives: CheckRepresentativeRow[],
  identityFieldsChanged: boolean,
): Promise<void> {
  const generalPersonFieldsChanged = identityFieldsChanged || owner.isPep !== data.isPep;
  if (generalPersonFieldsChanged && linkedRepresentatives.length > 0) {
    const synchronized = await tx.gwgRepresentative.updateMany({
      where: {
        gwgCheckId: data.checkId,
        linkedBeneficialOwnerId: data.ownerId,
      },
      data: {
        fullName: data.fullName,
        birthDate: new Date(data.birthDate),
        birthPlace: data.birthPlace,
        residence: data.residence,
        nationality: data.nationality,
        isPep: data.isPep,
      },
    });
    if (synchronized.count !== linkedRepresentatives.length) {
      throw new ActionError(
        'Die Doppelrolle konnte nicht vollständig synchronisiert werden. Bitte erneut versuchen.',
      );
    }
  }
  if (owner.fullName !== data.fullName && linkedRepresentatives.length > 0) {
    await tx.gwgCheck.update({
      where: { id: data.checkId },
      data: {
        representativeNames: representatives.map((representative) =>
          representative.linkedBeneficialOwnerId === data.ownerId
            ? data.fullName
            : representative.fullName,
        ),
      },
    });
  }
}

/** Entbestätigt die Ausweise des Owners und seiner verknüpften Vertreterrolle. */
async function invalidateOwnerIdentityDocumentsTx(
  tx: TxClient,
  data: BeneficialOwnerUpdateInput,
  linkedRepresentatives: CheckRepresentativeRow[],
): Promise<{ count: number; documentSetIds: string[] }> {
  const linkedRepresentativeIds = linkedRepresentatives.map((representative) => representative.id);
  const assignedDocuments = await tx.gwgIdDocument.findMany({
    where: {
      gwgCheckId: data.checkId,
      supersededAt: null,
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
      supersededAt: null,
    },
    data: {
      identityAssignmentConfirmedAt: null,
      identityAssignmentConfirmedBy: null,
      verifiedAt: null,
    },
  });
  return {
    count: invalidated.count,
    documentSetIds: assignedDocuments.map((document) => document.documentSetId),
  };
}

/**
 * Korrigiert die Angaben eines vorhandenen wirtschaftlich Berechtigten. Die
 * Check-Zeile wird zuerst per Status-CAS beansprucht; eine zeitgleiche Freigabe
 * gewinnt damit entweder vollstaendig oder wird sauber mit einem Konflikt
 * abgewiesen. Jede inhaltliche Korrektur nimmt eine laufende Freigabe zurueck.
 */
export async function updateBeneficialOwnerTx(
  tx: TxClient,
  data: BeneficialOwnerUpdateInput,
  actor: GwgStaffActor,
): Promise<{
  reviewReset: boolean;
  revision: string;
  saved: SavedBeneficialOwner;
  invalidatedIdentitySets?: InvalidatedIdentitySet[];
}> {
  return withEditableGwgCheckTx(
    tx,
    actor,
    {
      clientId: data.clientId,
      checkId: data.checkId,
      select: {
        status: true,
        beneficialOwners: { where: { id: data.ownerId }, select: OWNER_SNAPSHOT_SELECT },
        representatives: {
          select: { id: true, fullName: true, position: true, linkedBeneficialOwnerId: true },
          orderBy: [{ position: 'asc' }, { id: 'asc' }],
        },
      },
      beforeEditable: (check) => requireBeneficialOwner(check.beneficialOwners),
    },
    async (check, mutation) => {
      const owner = requireBeneficialOwner(check.beneficialOwners);
      if (gwgBeneficialOwnerRevision(owner) !== data.expectedRevision) {
        throw new ActionError(
          'Die Personendaten wurden zwischenzeitlich geändert. Bitte Seite neu laden; Ihre Eingabe wurde nicht überschrieben.',
        );
      }
      const identityFieldsChanged = ownerIdentityFieldsChanged(owner, data);
      const ownershipBefore = owner.ownershipPct === null ? null : Number(owner.ownershipPct);
      const ownershipAfter = data.ownershipPct ?? null;
      const contentChanged =
        identityFieldsChanged || ownershipBefore !== ownershipAfter || owner.isPep !== data.isPep;

      if (!contentChanged) {
        await mutation.confirmUnchanged();
        return {
          reviewReset: false,
          revision: gwgBeneficialOwnerRevision(owner),
          saved: savedBeneficialOwner(data),
        };
      }

      await mutation.claim({ invalidateRisk: true });
      const representatives = check.representatives ?? [];
      const linkedRepresentatives = representatives.filter(
        (representative) => representative.linkedBeneficialOwnerId === data.ownerId,
      );
      await synchronizeLinkedRepresentativesTx(
        tx,
        data,
        owner,
        representatives,
        linkedRepresentatives,
        identityFieldsChanged,
      );
      const invalidated = identityFieldsChanged
        ? await invalidateOwnerIdentityDocumentsTx(tx, data, linkedRepresentatives)
        : { count: 0, documentSetIds: [] };
      await tx.gwgBeneficialOwner.update({
        where: { id: data.ownerId },
        data: updatedOwnerColumns(data),
      });
      const invalidatedIdentitySets = await invalidatedIdentitySetRevisions(
        tx,
        data.checkId,
        invalidated.documentSetIds,
      );
      await evidenceService.record(tx, {
        tenantId: actor.tenantId,
        actorType: 'STAFF',
        actorId: actor.staffId,
        action: 'gwg.owner.update',
        resourceType: 'gwg_beneficial_owner',
        resourceId: data.ownerId,
        before: ownerAuditBefore(owner),
        after: ownerAuditAfter(data, invalidated.count),
      });
      return {
        reviewReset: check.status === 'IN_REVIEW',
        ...(invalidatedIdentitySets.length > 0 ? { invalidatedIdentitySets } : {}),
        revision: updatedOwnerRevision(data),
        saved: savedBeneficialOwner(data),
      };
    },
  );
}

// --- Entfernen --------------------------------------------------------------

export interface BeneficialOwnerRemovalInput {
  ownerId: string;
  checkId: string;
  clientId: string;
  expectedRevision: string;
}

/** Entbestätigt direkt zugeordnete Ausweise und löst sie vom entfernten Owner. */
async function detachOwnerIdentityDocumentsTx(
  tx: TxClient,
  data: BeneficialOwnerRemovalInput,
  linkedRepresentativeIds: string[],
): Promise<Array<{ id: string; documentSetId: string; beneficialOwnerSubjectId: string | null }>> {
  const affectedDocuments = await tx.gwgIdDocument.findMany({
    where: {
      gwgCheckId: data.checkId,
      supersededAt: null,
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
        supersededAt: null,
      },
      data: {
        beneficialOwnerSubjectId: null,
        identityAssignmentConfirmedAt: null,
        identityAssignmentConfirmedBy: null,
        verifiedAt: null,
      },
    });
  }
  return affectedDocuments;
}

/**
 * Entfernt eine nicht mehr wirtschaftlich berechtigte Person nur aus dem
 * aktuellen, bearbeitbaren Snapshot. Zugehörige Ausweisbelege bleiben in der
 * Akte erhalten, werden aber bewusst entbestätigt und müssen einer aktuellen
 * Person neu zugeordnet werden. Der alte VERIFIED-Snapshot bleibt unverändert.
 */
export async function removeBeneficialOwnerTx(
  tx: TxClient,
  data: BeneficialOwnerRemovalInput,
  actor: GwgStaffActor,
): Promise<{
  removedOwnerId: string;
  reviewReset: boolean;
  invalidatedIdentitySets?: InvalidatedIdentitySet[];
}> {
  return withEditableGwgCheckTx(
    tx,
    actor,
    {
      clientId: data.clientId,
      checkId: data.checkId,
      select: {
        status: true,
        representatives: {
          where: { linkedBeneficialOwnerId: data.ownerId },
          select: { id: true },
        },
        beneficialOwners: { where: { id: data.ownerId }, select: OWNER_SNAPSHOT_SELECT },
      },
    },
    async (check, mutation) => {
      const owner = requireBeneficialOwner(check.beneficialOwners);
      if (gwgBeneficialOwnerRevision(owner) !== data.expectedRevision) {
        throw new ActionError(
          'Die Personendaten wurden zwischenzeitlich geändert. Bitte Seite neu laden.',
        );
      }

      await mutation.claim({ invalidateRisk: true });
      const affectedDocuments = await detachOwnerIdentityDocumentsTx(
        tx,
        data,
        check.representatives.map((representative) => representative.id),
      );
      const unlinkedRepresentativeRoles = await tx.gwgRepresentative.updateMany({
        where: {
          gwgCheckId: data.checkId,
          linkedBeneficialOwnerId: data.ownerId,
        },
        data: {
          linkedBeneficialOwnerId: null,
          fullName: owner.fullName,
          birthDate: owner.birthDate,
          birthPlace: owner.birthPlace,
          residence: owner.residence,
          nationality: owner.nationality,
          isPep: owner.isPep,
        },
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
        tenantId: actor.tenantId,
        actorType: 'STAFF',
        actorId: actor.staffId,
        action: 'gwg.owner.remove',
        resourceType: 'gwg_beneficial_owner',
        resourceId: data.ownerId,
        before: ownerAuditBefore(owner),
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
    },
  );
}
