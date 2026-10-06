// =============================================================================
// GwG-Personen eines Rechtsträgers: Erfassung mit Rollen und allgemeine
// Angaben auf Personenebene (Review-Befund K-03, vormals Callbacks in
// app/staff/(protected)/clients/[id]/gwg/owner-actions.ts).
//
// Fachkatalog: GWG-BENEFICIAL-OWNERS-001, GWG-REPRESENTATIVE-AUTHORITY-001,
// GWG-IDENTIFICATION-EVIDENCE-001. Reihenfolge der Prüfungen, Schreibzugriffe
// und Audit-Ereignisse entspricht unverändert der früheren Action.
// =============================================================================

import { randomUUID } from 'node:crypto';
import type { TxClient } from '@taxtronik/db';
import { ActionError } from '@/server/actions/action-error';
import { evidenceService } from '@/server/container';
import { withEditableGwgCheckTx, type GwgStaffActor } from './editable-check';
import {
  invalidatedIdentitySetRevisions,
  type InvalidatedIdentitySet,
} from './invalidated-identity-sets';
import { gwgPersonGeneralRevision } from './revisions';

/** Personenrollen sind nur bei juristischen Personen/Personengesellschaften vorgesehen. */
export function assertLegalEntityClientKind(kind: string, message: string): void {
  if (kind !== 'JURPERS' && kind !== 'PERSGES') throw new ActionError(message);
}

export interface NewGwgPersonInput {
  checkId: string;
  clientId: string;
  fullName: string;
  isBeneficialOwner: boolean;
  isRepresentative: boolean;
  birthDate: string;
  birthPlace: string;
  residence: string;
  nationality: string;
  ownershipPct?: number;
  isPep: boolean;
}

/**
 * Erfasst eine relevante natürliche Person und ordnet ihr die ausgewählten
 * Rollen zu (wirtschaftlich berechtigt und/oder vertretungsberechtigt).
 */
export async function addGwgPersonTx(
  tx: TxClient,
  input: NewGwgPersonInput,
  actor: GwgStaffActor,
): Promise<void> {
  await withEditableGwgCheckTx(
    tx,
    actor,
    {
      clientId: input.clientId,
      checkId: input.checkId,
      select: {
        status: true,
        client: { select: { kind: true } },
        representatives: { select: { position: true }, orderBy: { position: 'asc' } },
      },
      beforeEditable: (check) =>
        assertLegalEntityClientKind(
          check.client.kind,
          'Zusätzliche Personenrollen sind nur bei Rechtsträgern vorgesehen.',
        ),
    },
    async (check, mutation) => {
      await mutation.claim({ invalidateRisk: true });

      const owner = input.isBeneficialOwner
        ? await tx.gwgBeneficialOwner.create({
            data: {
              gwgCheckId: input.checkId,
              fullName: input.fullName,
              birthDate: new Date(input.birthDate),
              birthPlace: input.birthPlace,
              residence: input.residence,
              nationality: input.nationality,
              ownershipPct: input.ownershipPct ?? null,
              isPep: input.isPep,
            },
            select: { id: true },
          })
        : null;
      const representativeId = input.isRepresentative ? randomUUID() : null;
      if (representativeId) {
        const position = Math.max(-1, ...check.representatives.map((entry) => entry.position)) + 1;
        await tx.gwgRepresentative.create({
          data: {
            id: representativeId,
            gwgCheckId: input.checkId,
            fullName: input.fullName,
            birthDate: new Date(input.birthDate),
            birthPlace: input.birthPlace,
            residence: input.residence,
            nationality: input.nationality,
            isPep: input.isPep,
            position,
            linkedBeneficialOwnerId: owner?.id ?? null,
          },
        });
      }

      await evidenceService.record(tx, {
        tenantId: actor.tenantId,
        actorType: 'STAFF',
        actorId: actor.staffId,
        action: 'gwg.person.add',
        resourceType: 'gwg_person',
        resourceId: owner?.id ?? representativeId!,
        after: {
          fullName: input.fullName,
          birthDate: input.birthDate,
          birthPlace: input.birthPlace,
          residence: input.residence,
          nationality: input.nationality,
          isPep: input.isPep,
          beneficialOwnerId: owner?.id ?? null,
          representativeId,
          roles: [
            ...(input.isBeneficialOwner ? ['WIRTSCHAFTLICH_BERECHTIGT'] : []),
            ...(input.isRepresentative ? ['VERTRETUNGSBERECHTIGT'] : []),
          ],
        },
      });
    },
  );
}

export interface SavedGwgPersonGeneral {
  fullName: string;
  birthDate: string;
  birthPlace: string;
  residence: string;
  nationality: string;
  isPep: boolean | null;
}

export type GwgPersonGeneralMutationPayload = {
  saved?: SavedGwgPersonGeneral;
  latest?: SavedGwgPersonGeneral;
  revision?: string;
  conflict?: boolean;
  reviewReset?: boolean;
  invalidatedIdentitySets?: InvalidatedIdentitySet[];
};

export interface GwgPersonGeneralInput {
  ownerId?: string;
  representativeId?: string;
  checkId: string;
  clientId: string;
  fullName: string;
  birthDate: string;
  birthPlace: string;
  residence: string;
  nationality: string;
  isPep: boolean;
  expectedRevision: string;
}

interface StoredPersonGeneral {
  id: string;
  fullName: string;
  birthDate: Date | null;
  birthPlace: string | null;
  residence: string | null;
  nationality: string | null;
  isPep: boolean | null;
}

interface StoredRepresentativeGeneral extends StoredPersonGeneral {
  position: number;
  linkedBeneficialOwnerId: string | null;
}

const PERSON_GENERAL_SELECT = {
  id: true,
  fullName: true,
  birthDate: true,
  birthPlace: true,
  residence: true,
  nationality: true,
  isPep: true,
} as const;

/** Eine Person kann Owner-, Vertreter- oder Doppelrolle haben; beide müssen zusammengehören. */
function resolvePersonRoles(
  input: GwgPersonGeneralInput,
  owner: StoredPersonGeneral | null,
  representative: StoredRepresentativeGeneral | null,
): StoredPersonGeneral {
  if (input.ownerId && !owner) throw new ActionError('Die Person wurde nicht gefunden.');
  if (input.representativeId && !representative) {
    throw new ActionError('Die Person wurde nicht gefunden.');
  }
  if (owner && representative && representative.linkedBeneficialOwnerId !== owner.id) {
    throw new ActionError('Die Rollen gehören nicht zu derselben Person.');
  }
  const source = owner ?? representative;
  if (!source) throw new ActionError('Die Person wurde nicht gefunden.');
  return source;
}

function storedPersonGeneral(source: StoredPersonGeneral) {
  return {
    fullName: source.fullName,
    birthDate: source.birthDate,
    birthPlace: source.birthPlace,
    residence: source.residence,
    nationality: source.nationality,
    isPep: source.isPep,
  };
}

function latestPersonGeneral(source: StoredPersonGeneral): SavedGwgPersonGeneral {
  return {
    fullName: source.fullName,
    birthDate: source.birthDate?.toISOString().slice(0, 10) ?? '',
    birthPlace: source.birthPlace ?? '',
    residence: source.residence ?? '',
    nationality: source.nationality ?? '',
    isPep: source.isPep,
  };
}

function personIdentityChanged(source: StoredPersonGeneral, input: GwgPersonGeneralInput): boolean {
  return (
    source.fullName !== input.fullName ||
    source.birthDate?.toISOString().slice(0, 10) !== input.birthDate ||
    (source.birthPlace ?? '') !== input.birthPlace ||
    (source.residence ?? '') !== input.residence ||
    (source.nationality ?? '') !== input.nationality
  );
}

/** Entbestätigt die aktiven Ausweise beider Rollen einer Person. */
async function invalidatePersonIdentityDocumentsTx(
  tx: TxClient,
  checkId: string,
  owner: StoredPersonGeneral | null,
  representative: StoredRepresentativeGeneral | null,
): Promise<Array<{ id: string; documentSetId: string }>> {
  const affectedDocuments = await tx.gwgIdDocument.findMany({
    where: {
      gwgCheckId: checkId,
      supersededAt: null,
      OR: [
        ...(owner ? [{ beneficialOwnerSubjectId: owner.id }] : []),
        ...(representative ? [{ representativeSubjectId: representative.id }] : []),
      ],
    },
    select: { id: true, documentSetId: true },
  });
  await tx.gwgIdDocument.updateMany({
    where: {
      gwgCheckId: checkId,
      id: { in: affectedDocuments.map((document) => document.id) },
      supersededAt: null,
    },
    data: {
      identityAssignmentConfirmedAt: null,
      identityAssignmentConfirmedBy: null,
      verifiedAt: null,
    },
  });
  return affectedDocuments;
}

/** Schreibt die allgemeinen Angaben in beide Rollensnapshots der Person. */
async function writePersonGeneralTx(
  tx: TxClient,
  input: GwgPersonGeneralInput,
  check: { representativeNames: string[] },
  owner: StoredPersonGeneral | null,
  representative: StoredRepresentativeGeneral | null,
): Promise<void> {
  const commonData = {
    fullName: input.fullName,
    birthDate: new Date(input.birthDate),
    birthPlace: input.birthPlace,
    residence: input.residence,
    nationality: input.nationality,
    isPep: input.isPep,
  };
  if (owner) {
    await tx.gwgBeneficialOwner.update({ where: { id: owner.id }, data: commonData });
  }
  if (!representative) return;
  await tx.gwgRepresentative.update({
    where: { id: representative.id },
    data: commonData,
  });
  if (representative.fullName !== input.fullName) {
    const representativeNames = [...check.representativeNames];
    representativeNames[representative.position] = input.fullName;
    await tx.gwgCheck.update({
      where: { id: input.checkId },
      data: { representativeNames },
    });
  }
}

/**
 * Speichert allgemeine Angaben einmal auf Personenebene. Bei einer Doppelrolle
 * werden die beiden bestehenden Rollensnapshots atomar synchronisiert. Eine
 * veraltete Revision liefert den aktuellen Stand (`conflict`) statt zu werfen.
 */
export async function updateGwgPersonGeneralTx(
  tx: TxClient,
  input: GwgPersonGeneralInput,
  actor: GwgStaffActor,
): Promise<GwgPersonGeneralMutationPayload> {
  return withEditableGwgCheckTx(
    tx,
    actor,
    {
      clientId: input.clientId,
      checkId: input.checkId,
      select: {
        status: true,
        representativeNames: true,
        beneficialOwners: {
          where: input.ownerId ? { id: input.ownerId } : { id: { in: [] } },
          select: PERSON_GENERAL_SELECT,
        },
        representatives: {
          where: input.representativeId ? { id: input.representativeId } : { id: { in: [] } },
          select: {
            ...PERSON_GENERAL_SELECT,
            position: true,
            linkedBeneficialOwnerId: true,
            personAnchorId: true,
          },
        },
      },
    },
    async (check, mutation): Promise<GwgPersonGeneralMutationPayload> => {
      const owner = check.beneficialOwners[0] ?? null;
      const representative = check.representatives[0] ?? null;
      const source = resolvePersonRoles(input, owner, representative);
      const currentGeneral = storedPersonGeneral(source);
      const currentRevision = gwgPersonGeneralRevision(currentGeneral);
      if (currentRevision !== input.expectedRevision) {
        return { conflict: true, latest: latestPersonGeneral(source), revision: currentRevision };
      }
      const saved: SavedGwgPersonGeneral = {
        fullName: input.fullName,
        birthDate: input.birthDate,
        birthPlace: input.birthPlace,
        residence: input.residence,
        nationality: input.nationality,
        isPep: input.isPep,
      };
      const identityChanged = personIdentityChanged(source, input);
      if (!identityChanged && source.isPep === input.isPep) {
        await mutation.confirmUnchanged();
        return { saved, revision: input.expectedRevision, reviewReset: false };
      }

      await mutation.claim({ invalidateRisk: true });
      const affectedDocuments = identityChanged
        ? await invalidatePersonIdentityDocumentsTx(tx, input.checkId, owner, representative)
        : [];
      await writePersonGeneralTx(tx, input, check, owner, representative);
      const invalidatedIdentitySets = await invalidatedIdentitySetRevisions(
        tx,
        input.checkId,
        affectedDocuments.map((document) => document.documentSetId),
      );
      await evidenceService.record(tx, {
        tenantId: actor.tenantId,
        actorType: 'STAFF',
        actorId: actor.staffId,
        action: 'gwg.person.general.update',
        resourceType: 'gwg_person',
        resourceId: owner?.id ?? representative!.id,
        before: {
          ...currentGeneral,
          birthDate: currentGeneral.birthDate?.toISOString().slice(0, 10) ?? null,
        },
        after: { ...saved, invalidatedIdentityDocuments: affectedDocuments.length },
      });
      return {
        saved,
        revision: gwgPersonGeneralRevision({
          ...saved,
          birthDate: input.birthDate,
        }),
        reviewReset: check.status === 'IN_REVIEW',
        invalidatedIdentitySets,
      };
    },
  );
}
