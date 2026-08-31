import { randomUUID } from 'node:crypto';

import { Prisma, type ClientKind } from '@prisma/client';
import type { TxClient } from '@taxtronik/db';

import { evidenceService } from '@/server/container';
import { startFreshGwgReviewTx } from '@/server/gwg/reverification';
import { log } from '@/server/logger';
import { notifyMany } from '@/server/notifications/service';
import { lockConsentCatalogTx } from '@/server/privacy/catalog-lock';
import { countGranted, type ConsentSelections } from '@/server/privacy/consent';
import { resolveConsentSelectionsTx } from '@/server/privacy/consent-catalog';
import { renderNoticeForTenantTx } from '@/server/privacy/service';

import { canStartUnboundGwgInviteTx, resolveBoundGwgInviteDraftTx } from './bound-review';
import {
  OnboardingIdentitySetConflictError,
  persistOnboardingIdentitySetTx,
  type ExistingOnboardingDocument,
} from './identity-persistence';
import {
  claimCurrentGwgInviteSubmitTx,
  type ClaimCurrentGwgInviteResult,
} from './invite-lifecycle';
import type { GwgOnboardingLegalEntityDeclaration } from './legal-entity-submission';
import { toBeneficialOwnerSnapshot } from './owner-submission';
import type { GwgOnboardingRepresentativeInput } from './representative-submission';
import {
  buildOnboardingClientMasterChange,
  type CurrentOnboardingClientMasterData,
  type OnboardingClientMasterChange,
  type OnboardingMasterDataInput,
} from './submission-master-data';
import type { OnboardingExtraDocument, OnboardingSubmissionOwner } from './submission-validation';
import { ensureGwgPersonFolderTx, ensureGwgRootFolderTx } from './document-folders';

export class BoundInviteDraftChangedError extends Error {}

export interface OnboardingSubmissionInviteContext {
  id: string;
  tenantId: string;
  clientId: string;
  gwgCheckId: string | null;
  clientKind: ClientKind;
  createdByStaff: string;
}

export interface OnboardingSubmissionConsentInput {
  signedByName: string;
  selections: ConsentSelections;
  displayRevision: string;
}

export interface OnboardingSubmissionTransactionInput {
  invite: OnboardingSubmissionInviteContext;
  tokenHash: string;
  submittedIp: string | null;
  submittedUserAgent: string | null;
  linkedOwnerLocalIds: readonly string[];
  master: OnboardingMasterDataInput;
  legalEntity: GwgOnboardingLegalEntityDeclaration;
  owners: OnboardingSubmissionOwner[];
  representatives: GwgOnboardingRepresentativeInput[];
  extraDocuments: OnboardingExtraDocument[];
  consent: OnboardingSubmissionConsentInput;
}

export type OnboardingSubmissionTransactionResult =
  | { ok: true }
  | { ok: false; reason: Extract<ClaimCurrentGwgInviteResult, { ok: false }>['reason'] };

interface SubmissionReviewPhase {
  checkId: string;
  invalidatedChecks: number;
  clientDeactivated: boolean;
}

interface CurrentSubmissionClient extends CurrentOnboardingClientMasterData {
  kind: ClientKind;
}

interface SubmittedPeoplePhase {
  ownerDbIds: Map<string, string>;
  representativeDbIds: Map<string, string>;
  representativeByOwnerLocalId: Map<string, string>;
  existingDocumentById: Map<string, ExistingOnboardingDocument>;
  replacedOwnerCount: number;
  replacedRepresentativeCount: number;
}

/**
 * Resolves the immutable review target after the invite has been claimed.
 * No client or GwG mutation may be placed before this phase in the script below.
 */
async function resolveSubmissionReviewTx(
  tx: TxClient,
  invite: OnboardingSubmissionInviteContext,
): Promise<SubmissionReviewPhase> {
  if (invite.gwgCheckId) {
    const boundDraft = await resolveBoundGwgInviteDraftTx(tx, {
      tenantId: invite.tenantId,
      clientId: invite.clientId,
      inviteId: invite.id,
      expectedCheckId: invite.gwgCheckId,
    });
    if (!boundDraft) throw new BoundInviteDraftChangedError();
    return {
      checkId: boundDraft.id,
      invalidatedChecks: 0,
      clientDeactivated: false,
    };
  }

  if (
    !(await canStartUnboundGwgInviteTx(tx, {
      tenantId: invite.tenantId,
      clientId: invite.clientId,
      inviteId: invite.id,
    }))
  ) {
    throw new BoundInviteDraftChangedError();
  }
  const review = await startFreshGwgReviewTx(tx, {
    tenantId: invite.tenantId,
    clientId: invite.clientId,
  });
  return {
    checkId: review.reviewCheckId,
    invalidatedChecks: review.invalidatedChecks,
    clientDeactivated: review.clientDeactivated,
  };
}

async function loadSubmissionClientTx(
  tx: TxClient,
  invite: OnboardingSubmissionInviteContext,
): Promise<CurrentSubmissionClient> {
  const client = await tx.client.findFirst({
    where: { id: invite.clientId, tenantId: invite.tenantId },
    select: {
      kind: true,
      name: true,
      street: true,
      postalCode: true,
      city: true,
      countryIso: true,
    },
  });
  if (!client || client.kind !== invite.clientKind) {
    throw new BoundInviteDraftChangedError();
  }
  return client;
}

async function resetSubmissionReviewRiskTx(tx: TxClient, checkId: string): Promise<void> {
  await tx.gwgCheck.update({
    where: { id: checkId },
    data: {
      riskLevel: null,
      riskScore: null,
      riskAnswers: Prisma.DbNull,
      riskBreakdown: Prisma.DbNull,
    },
  });
}

async function persistClientMasterPhaseTx(
  tx: TxClient,
  input: {
    invite: OnboardingSubmissionInviteContext;
    checkId: string;
    currentClient: CurrentSubmissionClient;
    master: OnboardingMasterDataInput;
    legalEntity: GwgOnboardingLegalEntityDeclaration;
  },
): Promise<OnboardingClientMasterChange> {
  const change = buildOnboardingClientMasterChange(input.currentClient, input.master);
  if (change.changedFields.length > 0) {
    await tx.client.update({ where: { id: input.invite.clientId }, data: change.after });
  }
  if (
    input.legalEntity &&
    (input.currentClient.kind === 'JURPERS' || input.currentClient.kind === 'PERSGES')
  ) {
    await tx.gwgCheck.update({
      where: { id: input.checkId },
      data: { noRegisterEntry: input.legalEntity.noRegisterEntry },
    });
  }
  return change;
}

async function replaceSubmittedPeopleTx(
  tx: TxClient,
  input: {
    checkId: string;
    reuseBoundDraft: boolean;
    owners: OnboardingSubmissionOwner[];
    representatives: GwgOnboardingRepresentativeInput[];
  },
): Promise<SubmittedPeoplePhase> {
  const existingOwners = input.reuseBoundDraft
    ? await tx.gwgBeneficialOwner.findMany({
        where: { gwgCheckId: input.checkId },
        select: { id: true, notes: true, personAnchorId: true },
      })
    : [];
  const existingOwnerIds = new Set(existingOwners.map((entry) => entry.id));
  const existingOwnerNotes = new Map(existingOwners.map((entry) => [entry.id, entry.notes]));
  const existingOwnerAnchors = new Map(
    existingOwners.map((entry) => [entry.id, entry.personAnchorId]),
  );
  const existingRepresentatives = input.reuseBoundDraft
    ? await tx.gwgRepresentative.findMany({
        where: { gwgCheckId: input.checkId },
        select: { id: true, personAnchorId: true },
      })
    : [];
  const existingRepresentativeIds = new Set(existingRepresentatives.map((entry) => entry.id));
  const existingRepresentativeAnchors = new Map(
    existingRepresentatives.map((entry) => [entry.id, entry.personAnchorId]),
  );
  const existingCheckDocuments = input.reuseBoundDraft
    ? await tx.gwgIdDocument.findMany({
        where: { gwgCheckId: input.checkId },
        select: { id: true, documentId: true, documentSetId: true, type: true },
      })
    : [];
  const existingDocumentById = new Map(
    existingCheckDocuments.flatMap((entry) =>
      entry.documentId ? [[entry.documentId, entry] as const] : [],
    ),
  );

  const replacedRepresentativeCount = await tx.gwgRepresentative.deleteMany({
    where: { gwgCheckId: input.checkId },
  });
  const replacedOwnerCount = await tx.gwgBeneficialOwner.deleteMany({
    where: { gwgCheckId: input.checkId },
  });

  const ownerDbIds = new Map(
    input.owners.map((owner) => [
      owner.localId,
      existingOwnerIds.has(owner.localId) ? owner.localId : randomUUID(),
    ]),
  );
  await tx.gwgBeneficialOwner.createMany({
    data: input.owners.map((owner) => {
      const snapshot = toBeneficialOwnerSnapshot(owner);
      return {
        id: ownerDbIds.get(owner.localId)!,
        gwgCheckId: input.checkId,
        ...snapshot,
        notes: existingOwnerNotes.get(owner.localId) ?? snapshot.notes,
        personAnchorId:
          existingOwnerAnchors.get(owner.localId) ??
          existingRepresentativeAnchors.get(
            input.representatives.find((person) => person.linkedOwnerLocalId === owner.localId)
              ?.localId ?? '',
          ) ??
          null,
      };
    }),
  });

  const representativeDbIds = new Map(
    input.representatives.map((representative) => [
      representative.localId,
      existingRepresentativeIds.has(representative.localId) ? representative.localId : randomUUID(),
    ]),
  );
  if (input.representatives.length > 0) {
    await tx.gwgRepresentative.createMany({
      data: input.representatives.map((representative, position) => ({
        id: representativeDbIds.get(representative.localId)!,
        personAnchorId: existingRepresentativeAnchors.get(representative.localId) ?? null,
        gwgCheckId: input.checkId,
        fullName: representative.linkedOwnerLocalId
          ? input.owners.find((owner) => owner.localId === representative.linkedOwnerLocalId)!
              .fullName
          : representative.fullName,
        position,
        linkedBeneficialOwnerId: representative.linkedOwnerLocalId
          ? ownerDbIds.get(representative.linkedOwnerLocalId)!
          : null,
      })),
    });
  }
  await tx.gwgCheck.update({
    where: { id: input.checkId },
    data: {
      representativeNames: input.representatives.map((representative) =>
        representative.linkedOwnerLocalId
          ? input.owners
              .find((owner) => owner.localId === representative.linkedOwnerLocalId)!
              .fullName.trim()
          : representative.fullName.trim(),
      ),
    },
  });

  const representativeByOwnerLocalId = new Map(
    input.representatives.flatMap((representative) =>
      representative.linkedOwnerLocalId
        ? [
            [
              representative.linkedOwnerLocalId,
              representativeDbIds.get(representative.localId)!,
            ] as const,
          ]
        : [],
    ),
  );
  return {
    ownerDbIds,
    representativeDbIds,
    representativeByOwnerLocalId,
    existingDocumentById,
    replacedOwnerCount: replacedOwnerCount.count,
    replacedRepresentativeCount: replacedRepresentativeCount.count,
  };
}

async function persistSubmittedIdentitySetsTx(
  tx: TxClient,
  input: {
    checkId: string;
    sourceScope: { tenantId: string; clientId: string };
    owners: OnboardingSubmissionOwner[];
    representatives: GwgOnboardingRepresentativeInput[];
    people: SubmittedPeoplePhase;
  },
): Promise<void> {
  for (const owner of input.owners) {
    const representativeSubjectId =
      input.people.representativeByOwnerLocalId.get(owner.localId) ?? null;
    const beneficialOwnerSubjectId = representativeSubjectId
      ? null
      : input.people.ownerDbIds.get(owner.localId)!;
    await persistOnboardingIdentitySetTx(tx, input.checkId, input.people.existingDocumentById, {
      documentIds: [owner.idFrontDocumentId, owner.idBackDocumentId],
      viewports: [owner.idFrontViewport, owner.idBackViewport],
      sourceScope: input.sourceScope,
      type: owner.idType,
      ownerName: owner.fullName.trim(),
      number: owner.idNumber?.trim() || null,
      issuedBy: owner.idIssuedBy?.trim() || null,
      issueDate: owner.idIssueDate ? new Date(`${owner.idIssueDate}T00:00:00.000Z`) : null,
      expiryDate: owner.idExpiryDate ? new Date(`${owner.idExpiryDate}T00:00:00.000Z`) : null,
      beneficialOwnerSubjectId,
      representativeSubjectId,
    });
  }

  for (const representative of input.representatives) {
    if (representative.linkedOwnerLocalId) continue;
    await persistOnboardingIdentitySetTx(tx, input.checkId, input.people.existingDocumentById, {
      documentIds: [representative.idFrontDocumentId!, representative.idBackDocumentId!],
      viewports: [representative.idFrontViewport, representative.idBackViewport],
      sourceScope: input.sourceScope,
      type: representative.idType,
      ownerName: representative.fullName.trim(),
      number: representative.idNumber?.trim() || null,
      issuedBy: representative.idIssuedBy?.trim() || null,
      issueDate: representative.idIssueDate
        ? new Date(`${representative.idIssueDate}T00:00:00.000Z`)
        : null,
      expiryDate: representative.idExpiryDate
        ? new Date(`${representative.idExpiryDate}T00:00:00.000Z`)
        : null,
      representativeSubjectId: input.people.representativeDbIds.get(representative.localId)!,
      notePrefix: 'Vertretung',
    });
  }
}

async function organizeSubmittedDocumentsTx(
  tx: TxClient,
  input: {
    invite: OnboardingSubmissionInviteContext;
    owners: OnboardingSubmissionOwner[];
    representatives: GwgOnboardingRepresentativeInput[];
    extraDocuments: OnboardingExtraDocument[];
  },
): Promise<void> {
  const rootFolderId = await ensureGwgRootFolderTx(tx, {
    tenantId: input.invite.tenantId,
    clientId: input.invite.clientId,
    createdByStaff: input.invite.createdByStaff,
  });
  const folderByDocumentId = new Map<string, string>();
  const assignFolder = (documentId: string, folderId: string) => {
    const existing = folderByDocumentId.get(documentId);
    if (existing && existing !== folderId) {
      throw new OnboardingIdentitySetConflictError();
    }
    folderByDocumentId.set(documentId, folderId);
  };

  for (const owner of input.owners) {
    const folderId = await ensureGwgPersonFolderTx(tx, {
      tenantId: input.invite.tenantId,
      clientId: input.invite.clientId,
      rootFolderId,
      personName: owner.fullName,
      createdByStaff: input.invite.createdByStaff,
    });
    assignFolder(owner.idFrontDocumentId, folderId);
    assignFolder(owner.idBackDocumentId, folderId);
  }

  for (const representative of input.representatives) {
    if (representative.linkedOwnerLocalId) continue;
    const folderId = await ensureGwgPersonFolderTx(tx, {
      tenantId: input.invite.tenantId,
      clientId: input.invite.clientId,
      rootFolderId,
      personName: representative.fullName,
      createdByStaff: input.invite.createdByStaff,
    });
    assignFolder(representative.idFrontDocumentId!, folderId);
    assignFolder(representative.idBackDocumentId!, folderId);
  }

  for (const evidence of input.extraDocuments) {
    assignFolder(evidence.documentId, rootFolderId);
  }

  for (const [documentId, folderId] of folderByDocumentId) {
    const updated = await tx.document.updateMany({
      where: {
        id: documentId,
        tenantId: input.invite.tenantId,
        clientId: input.invite.clientId,
        classification: 'GWG_EVIDENCE',
        deletedAt: null,
      },
      data: { folderId },
    });
    if (updated.count !== 1) throw new OnboardingIdentitySetConflictError();
  }
}

async function persistSubmittedEntityEvidenceTx(
  tx: TxClient,
  input: {
    checkId: string;
    clientName: string;
    documents: OnboardingExtraDocument[];
    existingDocumentById: ReadonlyMap<string, ExistingOnboardingDocument>;
  },
): Promise<void> {
  for (const evidence of input.documents) {
    const existingEvidence = input.existingDocumentById.get(evidence.documentId);
    const data = {
      gwgCheckId: input.checkId,
      type: evidence.type,
      ownerName: input.clientName,
      documentId: evidence.documentId,
    };
    if (existingEvidence) {
      await tx.gwgIdDocument.updateMany({
        where: {
          id: existingEvidence.id,
          gwgCheckId: input.checkId,
          documentId: evidence.documentId,
        },
        data,
      });
    } else {
      await tx.gwgIdDocument.create({
        data: {
          ...data,
          notes: 'Rechtsträger-/Zusatznachweis (durch Mandant hochgeladen)',
        },
      });
    }
  }
}

async function linkClaimedInviteToReviewTx(
  tx: TxClient,
  input: { inviteId: string; checkId: string },
): Promise<void> {
  await tx.gwgOnboardingInvite.update({
    where: { id: input.inviteId },
    data: { gwgCheckId: input.checkId },
  });
}

async function recordSubmissionAuditTx(
  tx: TxClient,
  input: {
    submission: OnboardingSubmissionTransactionInput;
    claim: Extract<ClaimCurrentGwgInviteResult, { ok: true }>;
    review: SubmissionReviewPhase;
    clientChange: OnboardingClientMasterChange;
    people: SubmittedPeoplePhase;
  },
): Promise<void> {
  const { submission, claim, review, clientChange, people } = input;
  const { invite, owners, representatives, legalEntity } = submission;
  await evidenceService.record(tx, {
    tenantId: invite.tenantId,
    actorType: 'CLIENT_CONTACT',
    actorId: null,
    action: 'gwg.onboarding.submit',
    resourceType: 'gwg_onboarding_invite',
    resourceId: invite.id,
    before: clientChange.before,
    after: {
      ...clientChange.after,
      changedFields: clientChange.changedFields,
      ownerCount: owners.length,
      representativeCount: representatives.length,
      linkedRoleCount: submission.linkedOwnerLocalIds.length,
      reusedBoundDraft: Boolean(invite.gwgCheckId),
      replacedOwnerCount: people.replacedOwnerCount,
      replacedRepresentativeCount: people.replacedRepresentativeCount,
      pepCount: owners.filter((owner) => owner.isPep).length,
      noRegisterEntry: legalEntity?.noRegisterEntry ?? null,
      gwgCheckId: review.checkId,
      supersededInviteCount: claim.supersededInviteCount,
      invalidatedChecks: review.invalidatedChecks,
      clientDeactivated: review.clientDeactivated,
    },
    ip: submission.submittedIp,
    userAgent: submission.submittedUserAgent,
  });
  if (clientChange.changedFields.length > 0) {
    await evidenceService.record(tx, {
      tenantId: invite.tenantId,
      actorType: 'CLIENT_CONTACT',
      actorId: null,
      action: 'client.update.gwg_relevant',
      resourceType: 'client',
      resourceId: invite.clientId,
      before: clientChange.before,
      after: {
        ...clientChange.after,
        _changedFields: clientChange.changedFields,
        _via: 'gwg_onboarding',
      },
      ip: submission.submittedIp,
      userAgent: submission.submittedUserAgent,
    });
  }
}

async function notifySubmissionTx(
  tx: TxClient,
  input: {
    invite: OnboardingSubmissionInviteContext;
    clientName: string;
  },
): Promise<void> {
  const responsibilities = await tx.clientResponsibility.findMany({
    where: { clientId: input.invite.clientId, role: { in: ['BERUFSTRAEGER', 'HAUPTBEARBEITER'] } },
    select: { staffId: true },
  });
  const staffIds = Array.from(
    new Set(responsibilities.map((responsibility) => responsibility.staffId)),
  );
  try {
    await notifyMany(tx, staffIds.length > 0 ? staffIds : [null], {
      tenantId: input.invite.tenantId,
      kind: 'GWG_ONBOARDING_SUBMITTED',
      title: 'GwG-Onboarding eingereicht',
      body: `${input.clientName} hat GwG-Angaben und Unterlagen übermittelt.`,
      href: `/staff/clients/${input.invite.clientId}/gwg`,
      resourceType: 'gwg_onboarding_invite',
      resourceId: input.invite.id,
    });
  } catch (error) {
    log.error(
      {
        component: 'gwg-onboarding-submit',
        inviteId: input.invite.id,
        tenantId: input.invite.tenantId,
        clientId: input.invite.clientId,
        name: (error as Error)?.name,
        err: (error as Error)?.message,
      },
      'GwG onboarding submit notification failed',
    );
  }
}

/** This final phase deliberately owns the last tenant-wide lock in the transaction. */
async function persistSubmissionConsentFinalizationTx(
  tx: TxClient,
  input: {
    invite: OnboardingSubmissionInviteContext;
    consent: OnboardingSubmissionConsentInput;
  },
): Promise<void> {
  await lockConsentCatalogTx(tx, input.invite.tenantId);
  const notice = await renderNoticeForTenantTx(tx, input.invite.tenantId);
  if (!notice.complete) throw new Error('PRIVACY_CONFIG_INCOMPLETE');

  const selections = await resolveConsentSelectionsTx(
    tx,
    input.invite.tenantId,
    input.consent.selections,
    {
      enforceRequired: true,
      expectedDisplay: {
        revision: input.consent.displayRevision,
        notice,
      },
    },
  );
  const consentRow = await tx.clientConsent.create({
    data: {
      tenantId: input.invite.tenantId,
      clientId: input.invite.clientId,
      noticeVersion: notice.version,
      noticeSnapshot: notice.body,
      consents: selections as object,
      source: 'PORTAL',
      signedByName: input.consent.signedByName.trim(),
      isRevocation: false,
      note: 'Über GwG-Onboarding-Portal erteilt',
      createdBy: null,
    },
  });
  await evidenceService.record(tx, {
    tenantId: input.invite.tenantId,
    actorType: 'CLIENT_CONTACT',
    actorId: null,
    action: 'privacy.consent.grant',
    resourceType: 'client_consent',
    resourceId: consentRow.id,
    after: {
      clientId: input.invite.clientId,
      noticeVersion: notice.version,
      grantedCount: countGranted(selections),
      signedByName: input.consent.signedByName.trim(),
      source: 'PORTAL',
      displayRevision: input.consent.displayRevision,
    },
  });
}

/**
 * The transaction body stays as a readable phase script. Every helper receives
 * the same TxClient, so the original all-or-nothing boundary remains intact.
 */
export async function runOnboardingSubmissionTransactionTx(
  tx: TxClient,
  submission: OnboardingSubmissionTransactionInput,
): Promise<OnboardingSubmissionTransactionResult> {
  // Phase 1: one-time claim and supersession. Must precede every mutation.
  const claim = await claimCurrentGwgInviteSubmitTx(tx, {
    tenantId: submission.invite.tenantId,
    clientId: submission.invite.clientId,
    inviteId: submission.invite.id,
    tokenHash: submission.tokenHash,
    submittedIp: submission.submittedIp,
    submittedUa: submission.submittedUserAgent,
  });
  if (!claim.ok) return claim;

  // Phase 2: bind or create the review and revalidate the client snapshot.
  const review = await resolveSubmissionReviewTx(tx, submission.invite);
  const currentClient = await loadSubmissionClientTx(tx, submission.invite);
  await resetSubmissionReviewRiskTx(tx, review.checkId);

  // Phase 3: persist normalized client and legal-entity master data.
  const clientChange = await persistClientMasterPhaseTx(tx, {
    invite: submission.invite,
    checkId: review.checkId,
    currentClient,
    master: submission.master,
    legalEntity: submission.legalEntity,
  });

  // Phase 4: replace submitted people, then bind identity and entity evidence.
  const people = await replaceSubmittedPeopleTx(tx, {
    checkId: review.checkId,
    reuseBoundDraft: Boolean(submission.invite.gwgCheckId),
    owners: submission.owners,
    representatives: submission.representatives,
  });
  await organizeSubmittedDocumentsTx(tx, {
    invite: submission.invite,
    owners: submission.owners,
    representatives: submission.representatives,
    extraDocuments: submission.extraDocuments,
  });
  await persistSubmittedIdentitySetsTx(tx, {
    sourceScope: { tenantId: submission.invite.tenantId, clientId: submission.invite.clientId },
    checkId: review.checkId,
    owners: submission.owners,
    representatives: submission.representatives,
    people,
  });
  await persistSubmittedEntityEvidenceTx(tx, {
    checkId: review.checkId,
    clientName: clientChange.after.name,
    documents: submission.extraDocuments,
    existingDocumentById: people.existingDocumentById,
  });

  // Phase 5: finalize the invite relation and append immutable audit records.
  await linkClaimedInviteToReviewTx(tx, {
    inviteId: submission.invite.id,
    checkId: review.checkId,
  });
  await recordSubmissionAuditTx(tx, { submission, claim, review, clientChange, people });

  // Phase 6: best-effort staff notification remains inside the same callback.
  await notifySubmissionTx(tx, {
    invite: submission.invite,
    clientName: clientChange.after.name,
  });

  // Phase 7: final display-CAS and immutable consent snapshot. Keep this last.
  await persistSubmissionConsentFinalizationTx(tx, {
    invite: submission.invite,
    consent: submission.consent,
  });
  return { ok: true };
}
