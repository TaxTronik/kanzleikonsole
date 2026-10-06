// =============================================================================
// Rechtsträger-Angaben einer GwG-Prüfung: Rechtsform, Register, gesetzliche
// Vertretung und Eigentümerstruktur (Review-Befund K-03, vormals Callback in
// app/staff/(protected)/clients/[id]/gwg/actions.ts).
//
// Fachkatalog: GWG-REPRESENTATIVE-AUTHORITY-001, GWG-BENEFICIAL-OWNERS-001,
// GWG-IDENTIFICATION-EVIDENCE-001. Reihenfolge der Prüfungen, Schreibzugriffe
// und Audit-Ereignisse entspricht unverändert der früheren Action.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { TxClient } from '@taxtronik/db';
import { ActionError } from '@/server/actions/action-error';
import { evidenceService } from '@/server/container';
import type { EditableGwgStatus } from './check-mutation';
import { withEditableGwgCheckTx, type GwgStaffActor } from './editable-check';
import {
  invalidatedIdentitySetRevisions,
  type InvalidatedIdentitySet,
} from './invalidated-identity-sets';
import { assertLegalEntityClientKind } from './persons';
import { syncGwgRepresentativesTx } from './representatives';
import { gwgLegalEntityRevision } from './revisions';

export interface LegalEntityDetailsInput {
  checkId: string;
  clientId: string;
  legalForm: string;
  registerNumber?: string;
  registerAuthority?: string;
  noRegisterEntry: boolean;
  representatives: Array<{
    id?: string | null;
    fullName: string;
    isNew?: boolean;
    linkedBeneficialOwnerId?: string | null;
  }>;
  ownershipStructureNotes: string;
  expectedRevision: string;
}

export interface SavedLegalEntityRepresentative {
  id: string;
  fullName: string;
  position: number;
  linkedBeneficialOwnerId: string | null;
}

export interface LegalEntityDetails {
  legalForm: string;
  registerNumber: string | null;
  registerAuthority: string | null;
  noRegisterEntry: boolean;
  representativeNames: string[];
  ownershipStructureNotes: string;
}

export type LegalEntityDetailsResult = {
  reviewReset: boolean;
  representativesChanged: boolean;
  representatives: SavedLegalEntityRepresentative[];
  details: LegalEntityDetails;
  invalidatedIdentitySets?: InvalidatedIdentitySet[];
  revision: string;
};

interface LinkedOwnerGeneralData {
  id: string;
  fullName: string;
  birthDate: Date | null;
  birthPlace: string | null;
  residence: string | null;
  nationality: string | null;
  isPep: boolean;
}

interface StoredRepresentative {
  id: string;
  fullName: string;
  position: number;
  linkedBeneficialOwnerId: string | null;
}

interface SubmittedRepresentative extends SavedLegalEntityRepresentative {
  isNew: boolean;
}

interface StoredLegalEntity {
  status: EditableGwgStatus;
  legalForm: string | null;
  registerNumber: string | null;
  registerAuthority: string | null;
  noRegisterEntry: boolean;
  representativeNames: string[];
  representatives: StoredRepresentative[];
  ownershipStructureNotes: string | null;
}

async function synchronizeLinkedRepresentativeGeneralDataTx(
  tx: TxClient,
  input: {
    enabled: boolean;
    checkId: string;
    representatives: Array<{ id: string; linkedBeneficialOwnerId: string | null }>;
    ownersById: Map<string, LinkedOwnerGeneralData>;
  },
): Promise<void> {
  if (!input.enabled) return;
  for (const representative of input.representatives) {
    if (!representative.linkedBeneficialOwnerId) continue;
    const linkedOwner = input.ownersById.get(representative.linkedBeneficialOwnerId);
    if (!linkedOwner) {
      throw new ActionError(
        'Die verknüpfte wirtschaftlich berechtigte Person gehört nicht mehr zu dieser Prüfung.',
      );
    }
    const synchronized = await tx.gwgRepresentative.updateMany({
      where: {
        id: representative.id,
        gwgCheckId: input.checkId,
        linkedBeneficialOwnerId: linkedOwner.id,
      },
      data: {
        fullName: linkedOwner.fullName,
        birthDate: linkedOwner.birthDate,
        birthPlace: linkedOwner.birthPlace,
        residence: linkedOwner.residence,
        nationality: linkedOwner.nationality,
        isPep: linkedOwner.isPep,
      },
    });
    if (synchronized.count !== 1) {
      throw new ActionError(
        'Die Doppelrolle konnte nicht vollständig synchronisiert werden. Bitte erneut versuchen.',
      );
    }
  }
}

/**
 * Löst die übermittelte Vertreterliste gegen den gespeicherten Snapshot auf:
 * stabile IDs (auch für Alt-Einträge ohne ID per Position), neue Personen und
 * die Doppelrolle mit einer wirtschaftlich berechtigten Person.
 */
function submittedRepresentatives(
  data: LegalEntityDetailsInput,
  stored: StoredRepresentative[],
  ownersById: Map<string, LinkedOwnerGeneralData>,
): SubmittedRepresentative[] {
  const currentById = new Map(stored.map((representative) => [representative.id, representative]));
  return data.representatives.map((representative, position) => {
    const legacyMatch = representative.id ? null : (stored[position] ?? null);
    const id = representative.id ?? legacyMatch?.id ?? randomUUID();
    const existing = currentById.get(id);
    if (representative.isNew && existing) {
      throw new ActionError('Die neue Person ist bereits vorhanden. Bitte Seite neu laden.');
    }
    if (!representative.isNew && representative.id && !existing) {
      throw new ActionError(
        'Mindestens eine ausgewählte Person gehört nicht mehr zu dieser Prüfung.',
      );
    }
    const linkedBeneficialOwnerId = representative.linkedBeneficialOwnerId ?? null;
    const linkedOwner = linkedBeneficialOwnerId ? ownersById.get(linkedBeneficialOwnerId) : null;
    if (linkedBeneficialOwnerId && !linkedOwner) {
      throw new ActionError(
        'Die verknüpfte wirtschaftlich berechtigte Person gehört nicht mehr zu dieser Prüfung.',
      );
    }
    return {
      id,
      fullName: linkedOwner
        ? linkedOwner.fullName
        : representative.fullName.trim().replace(/\s+/g, ' '),
      position,
      isNew: !existing,
      linkedBeneficialOwnerId,
    };
  });
}

function legalEntityDetails(
  data: LegalEntityDetailsInput,
  submitted: SubmittedRepresentative[],
): LegalEntityDetails {
  return {
    legalForm: data.legalForm,
    registerNumber: data.noRegisterEntry ? null : data.registerNumber || null,
    registerAuthority: data.noRegisterEntry ? null : data.registerAuthority || null,
    noRegisterEntry: data.noRegisterEntry,
    representativeNames: submitted.map((representative) => representative.fullName),
    ownershipStructureNotes: data.ownershipStructureNotes,
  };
}

function representativesChangedFrom(
  stored: StoredRepresentative[],
  submitted: SubmittedRepresentative[],
): boolean {
  return (
    stored.length !== submitted.length ||
    stored.some(
      (representative, index) =>
        representative.id !== submitted[index]?.id ||
        representative.position !== index ||
        representative.fullName !== submitted[index]?.fullName ||
        (representative.linkedBeneficialOwnerId ?? null) !==
          submitted[index]?.linkedBeneficialOwnerId,
    )
  );
}

function legalDetailsChangedFrom(check: StoredLegalEntity, after: LegalEntityDetails): boolean {
  return (
    check.legalForm !== after.legalForm ||
    check.registerNumber !== after.registerNumber ||
    check.registerAuthority !== after.registerAuthority ||
    check.noRegisterEntry !== after.noRegisterEntry ||
    check.ownershipStructureNotes !== after.ownershipStructureNotes
  );
}

function savedRepresentativesOf(
  submitted: SubmittedRepresentative[],
): SavedLegalEntityRepresentative[] {
  return submitted.map(({ id, fullName, position, linkedBeneficialOwnerId }) => ({
    id,
    fullName,
    position,
    linkedBeneficialOwnerId,
  }));
}

/**
 * Speichert eine inhaltliche Änderung: Review-Reset, Risiko-Rücknahme und
 * Fachwerte atomar in einem CAS-Update, danach Vertretersynchronisation.
 */
async function writeLegalEntityChangesTx(
  tx: TxClient,
  data: LegalEntityDetailsInput,
  check: StoredLegalEntity,
  change: {
    after: LegalEntityDetails;
    submitted: SubmittedRepresentative[];
    representativesChanged: boolean;
    ownersById: Map<string, LinkedOwnerGeneralData>;
  },
): Promise<{ invalidatedIdentityDocuments: number; invalidatedIdentityDocumentSetIds: string[] }> {
  // Wie bei der Risikobewertung: Review-Reset + Fachwerte atomar in einem
  // CAS-Update statt in zwei seriellen Statements speichern.
  const updated = await tx.gwgCheck.updateMany({
    where: { id: data.checkId, clientId: data.clientId, status: check.status },
    data: {
      status: 'DRAFT',
      reviewSubmittedAt: null,
      reviewSubmittedBy: null,
      riskLevel: null,
      riskScore: null,
      riskAnswers: Prisma.DbNull,
      riskBreakdown: Prisma.DbNull,
      ...change.after,
    },
  });
  if (updated.count === 0) {
    throw new ActionError(
      'Der Prüfstatus wurde parallel geändert. Ihre Eingabe wurde nicht gespeichert; bitte Seite neu laden.',
    );
  }
  const representativeSync = change.representativesChanged
    ? await syncGwgRepresentativesTx(tx, {
        checkId: data.checkId,
        currentRepresentatives: check.representatives.map((representative) => ({
          ...representative,
          linkedBeneficialOwnerId: representative.linkedBeneficialOwnerId ?? null,
        })),
        submittedRepresentatives: change.submitted,
      })
    : { invalidatedIdentityDocuments: 0, invalidatedIdentityDocumentSetIds: [] };
  await synchronizeLinkedRepresentativeGeneralDataTx(tx, {
    enabled: change.representativesChanged,
    checkId: data.checkId,
    representatives: change.submitted,
    ownersById: change.ownersById,
  });
  return representativeSync;
}

/**
 * Speichert die Rechtsträger-Angaben einer bearbeitbaren Prüfung. Ein echter
 * No-op-Save prüft nur den Status (CAS), ohne eine laufende Freigabe
 * zurückzusetzen; jede inhaltliche Änderung nimmt Freigabe und Risiko zurück.
 */
export async function saveLegalEntityDetailsTx(
  tx: TxClient,
  data: LegalEntityDetailsInput,
  actor: GwgStaffActor,
): Promise<LegalEntityDetailsResult> {
  return withEditableGwgCheckTx(
    tx,
    actor,
    {
      clientId: data.clientId,
      checkId: data.checkId,
      select: {
        status: true,
        legalForm: true,
        registerNumber: true,
        registerAuthority: true,
        noRegisterEntry: true,
        representativeNames: true,
        representatives: {
          select: { id: true, fullName: true, position: true, linkedBeneficialOwnerId: true },
          orderBy: [{ position: 'asc' }, { id: 'asc' }],
        },
        beneficialOwners: {
          select: {
            id: true,
            fullName: true,
            birthDate: true,
            birthPlace: true,
            residence: true,
            nationality: true,
            isPep: true,
          },
        },
        ownershipStructureNotes: true,
        client: { select: { kind: true } },
      },
      beforeEditable: (check) =>
        assertLegalEntityClientKind(
          check.client.kind,
          'Rechtsträger-Angaben sind nur bei juristischen Personen/Personengesellschaften erforderlich.',
        ),
    },
    async (check, mutation): Promise<LegalEntityDetailsResult> => {
      if (gwgLegalEntityRevision(check) !== data.expectedRevision) {
        throw new ActionError(
          'Die Rechtsträger-Angaben wurden zwischenzeitlich geändert. Bitte Seite neu laden; Ihre Eingabe wurde nicht überschrieben.',
        );
      }
      const ownersById = new Map((check.beneficialOwners ?? []).map((owner) => [owner.id, owner]));
      const submitted = submittedRepresentatives(data, check.representatives, ownersById);
      const after = legalEntityDetails(data, submitted);
      const representativesChanged = representativesChangedFrom(check.representatives, submitted);
      const savedRepresentatives = savedRepresentativesOf(submitted);
      const revision = gwgLegalEntityRevision({ ...after, representatives: savedRepresentatives });
      if (!legalDetailsChangedFrom(check, after) && !representativesChanged) {
        await mutation.confirmUnchanged();
        return {
          reviewReset: false,
          representativesChanged: false,
          representatives: savedRepresentatives,
          details: after,
          revision,
        };
      }
      const { invalidatedIdentityDocuments, invalidatedIdentityDocumentSetIds } =
        await writeLegalEntityChangesTx(tx, data, check, {
          after,
          submitted,
          representativesChanged,
          ownersById,
        });
      const invalidatedIdentitySets = await invalidatedIdentitySetRevisions(
        tx,
        data.checkId,
        invalidatedIdentityDocumentSetIds,
      );
      await evidenceService.record(tx, {
        tenantId: actor.tenantId,
        actorType: 'STAFF',
        actorId: actor.staffId,
        action: 'gwg.legal_entity_details.update',
        resourceType: 'gwg_check',
        resourceId: data.checkId,
        before: {
          legalForm: check.legalForm,
          registerNumber: check.registerNumber,
          registerAuthority: check.registerAuthority,
          noRegisterEntry: check.noRegisterEntry,
          representativeNames: check.representativeNames,
          ownershipStructureNotes: check.ownershipStructureNotes,
        },
        after: {
          ...after,
          representatives: savedRepresentativesOf(submitted),
          invalidatedIdentityDocuments,
        },
      });
      return {
        reviewReset: check.status === 'IN_REVIEW',
        representativesChanged,
        representatives: savedRepresentatives,
        details: after,
        ...(invalidatedIdentitySets.length > 0 ? { invalidatedIdentitySets } : {}),
        revision,
      };
    },
  );
}
