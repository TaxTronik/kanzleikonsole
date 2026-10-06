// =============================================================================
// GwG-Prüfung: Übergabe zur Freigabe, Verifikation und Ablehnung durch den
// zugeordneten Berufsträger (Review-Befund K-03, vormals Callbacks in
// app/staff/(protected)/clients/[id]/gwg/actions.ts).
//
// Fachkatalog: GWG-RISK-REVIEW-001, GWG-ACTIVATION-GATE-001,
// GWG-SCREENING-001, GWG-REVERIFICATION-VALIDITY-001. Sperrordnung (Lifecycle
// → Berufsträger → Snapshot), Prüfungen, Schreibzugriffe und Audit-Ereignisse
// entsprechen unverändert der früheren Action; die Reihenfolge prüft
// server/gwg/__tests__/lifecycle-lock-call-sites.test.ts.
// =============================================================================

import type { TxClient } from '@taxtronik/db';
import { resolveNotificationsTx } from '@taxtronik/db/notification';
import { portalBaseUrl } from '@taxtronik/config';
import { ActionError } from '@/server/actions/action-error';
import { assertClientAccessTx } from '@/server/auth/rbac';
import { revokeAllSessions } from '@/server/auth/revocation';
import { evidenceService } from '@/server/container';
import { organizeGwgDocumentsTx } from '@/server/gwg-onboarding/document-folders';
import { cancelOpenGwgInvitesTx } from '@/server/gwg-onboarding/invite-lifecycle';
import { enqueueClientContactsMailTx } from '@/server/mail/outbox';
import { notifyMany } from '@/server/notifications/service';
import { assertGwgScreeningReadyTx } from '@/server/screening/gwg-gate';
import type { GwgStaffActor } from './editable-check';
import { lockStaffGwgReviewerTx } from './professional-review';
import { lockGwgCheckLifecycleTx } from './reverification';
import {
  gwgProfessionalReviewSnapshotHash,
  type GwgProfessionalReviewSource,
} from './review-snapshot';
import { DEFAULT_FACTORS, riskValidForDays } from './risk-score';
import { gwgDecisionGateErrors, type GwgDecisionGateSnapshot } from './verification';

export interface GwgCheckDecisionInput {
  checkId: string;
  clientId: string;
}

/**
 * Defense in Depth für Bestandsdaten, die bereits vor der Terminalisierung
 * älterer Reviews mehrere offene Checks enthalten konnten. Entscheidungen
 * sind ausschließlich am neuesten Snapshot des Mandanten zulässig.
 */
async function assertLatestCheckForDecision(
  tx: TxClient,
  input: { clientId: string; checkId: string },
): Promise<void> {
  const latest = await tx.gwgCheck.findFirst({
    where: { clientId: input.clientId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true },
  });
  if (!latest || latest.id !== input.checkId) {
    throw new ActionError(
      'Für diesen Mandanten existiert bereits eine neuere GwG-Prüfung. Die ältere Prüfung darf nicht mehr entschieden werden; bitte Seite neu laden.',
    );
  }
}

/** Schließt die Freigabeanforderung des Checks und offene Einladungshinweise. */
export async function resolveGwgCheckNotificationsTx(
  tx: TxClient,
  input: { tenantId: string; checkId: string },
): Promise<void> {
  const invites = await tx.gwgOnboardingInvite.findMany({
    where: { tenantId: input.tenantId, gwgCheckId: input.checkId },
    select: { id: true },
  });
  await resolveNotificationsTx(tx, {
    tenantId: input.tenantId,
    resources: [
      { resourceType: 'gwg_check', resourceId: input.checkId },
      ...invites.map((invite) => ({
        resourceType: 'gwg_onboarding_invite',
        resourceId: invite.id,
      })),
    ],
  });
}

const DECISION_ID_DOCUMENTS_INCLUDE = {
  include: {
    document: {
      select: {
        id: true,
        clientId: true,
        classification: true,
        deletedAt: true,
        gwgDestructionRequestedAt: true,
        gwgDestroyedAt: true,
        versions: {
          orderBy: { versionNo: 'desc' },
          take: 1,
          select: { scanStatus: true, scanCompletedAt: true },
        },
      },
    },
  },
} as const;

type DecisionGateCheck = Omit<GwgDecisionGateSnapshot, 'checkId' | 'clientId' | 'clientKind'> & {
  client: { kind: GwgDecisionGateSnapshot['clientKind'] };
};

/** Vollständigkeits-Gate des gespeicherten Snapshots (Risiko, Personen, Nachweise). */
function assertDecisionGate(check: DecisionGateCheck, input: GwgCheckDecisionInput): void {
  const decisionErrors = gwgDecisionGateErrors(
    {
      ...check,
      checkId: input.checkId,
      clientId: input.clientId,
      clientKind: check.client.kind,
    },
    DEFAULT_FACTORS.map((factor) => factor.key),
  );
  if (decisionErrors.length > 0) throw new ActionError(decisionErrors.join(' '));
}

/**
 * Explizite Übergabe vom vorbereitenden Mitarbeiter an den verantwortlichen
 * Berufsträger. Anders als der frühere Statuswechsel beim Score-Speichern
 * prüft dieser Übergang den vollständigen, gespeicherten Snapshot.
 */
export async function submitCheckForReviewTx(
  tx: TxClient,
  input: GwgCheckDecisionInput,
  actor: GwgStaffActor,
): Promise<void> {
  const { tenantId, staffId } = actor;
  const { checkId, clientId } = input;
  await assertClientAccessTx(tx, actor.session, clientId);
  await lockGwgCheckLifecycleTx(tx, { tenantId, clientId });
  const check = await tx.gwgCheck.findFirst({
    where: { id: checkId, clientId },
    include: {
      client: { select: { id: true, kind: true, name: true } },
      beneficialOwners: true,
      representatives: { orderBy: [{ position: 'asc' }, { id: 'asc' }] },
      idDocuments: DECISION_ID_DOCUMENTS_INCLUDE,
    },
  });
  if (!check) throw new ActionError('GwG-Check nicht gefunden.');
  await assertLatestCheckForDecision(tx, { clientId, checkId });
  if (check.status === 'IN_REVIEW') return;
  if (check.status !== 'DRAFT') {
    throw new ActionError('Nur ein Entwurf kann zur Freigabe eingereicht werden.');
  }
  assertDecisionGate(check, input);

  const reviewers = await tx.clientResponsibility.findMany({
    where: {
      clientId,
      role: 'BERUFSTRAEGER',
      staff: { tenantId, active: true, isProfessional: true, roles: { some: {} } },
    },
    select: { staffId: true },
  });
  const reviewerIds = Array.from(new Set(reviewers.map((row) => row.staffId)));
  if (reviewerIds.length === 0) {
    throw new ActionError(
      'Bitte zuerst einen verantwortlichen Berufsträger in den Stammdaten zuordnen.',
    );
  }

  const submittedAt = new Date();
  const claim = await tx.gwgCheck.updateMany({
    where: { id: checkId, clientId, status: 'DRAFT' },
    data: {
      status: 'IN_REVIEW',
      reviewSubmittedAt: submittedAt,
      reviewSubmittedBy: staffId,
    },
  });
  if (claim.count === 0) {
    throw new ActionError('Der Prüfstatus hat sich geändert — bitte Seite neu laden.');
  }
  await resolveGwgCheckNotificationsTx(tx, {
    tenantId,
    checkId,
  });
  await cancelOpenGwgInvitesTx(tx, {
    tenantId,
    clientId,
    cancelledByStaff: staffId,
  });
  await evidenceService.record(tx, {
    tenantId,
    actorType: 'STAFF',
    actorId: staffId,
    action: 'gwg.check.submit_for_review',
    resourceType: 'gwg_check',
    resourceId: checkId,
    after: { reviewSubmittedAt: submittedAt.toISOString(), reviewerIds },
  });
  await notifyMany(tx, reviewerIds, {
    tenantId,
    kind: 'GWG_ONBOARDING_SUBMITTED',
    title: 'GwG-Prüfung zur Freigabe',
    body: `${check.client.name} wurde fachlich vorbereitet und wartet auf Ihre Freigabe.`,
    href: `/staff/clients/${clientId}/gwg`,
    resourceType: 'gwg_check',
    resourceId: checkId,
  });
}

export interface GwgVerificationInput extends GwgCheckDecisionInput {
  reviewSnapshotHash: string;
}

export interface GwgVerificationResult {
  validUntil: string;
  /** Erste erfolgreiche Freigabe des Mandanten: Begrüßungsmail ist eingereiht. */
  sendActivationWelcome: boolean;
}

/**
 * Nur der übergebene, unveränderte und vollständige Prüfsnapshot darf
 * verifiziert werden. Liefert den aktuellen Snapshot-Hash für das Audit.
 */
function assertVerifiableSnapshot(
  check: GwgProfessionalReviewSource &
    DecisionGateCheck & {
      reviewSubmittedAt: Date | null;
      reviewSubmittedBy: string | null;
    },
  input: GwgVerificationInput,
): string {
  if (check.status !== 'IN_REVIEW') {
    throw new ActionError(
      'GwG-Check ist nicht mehr im Prüfstatus. Bitte den aktuellen Snapshot neu öffnen.',
    );
  }
  if (!check.reviewSubmittedAt || !check.reviewSubmittedBy) {
    throw new ActionError(
      'Die dokumentierte Übergabe zur Berufsträger-Prüfung fehlt. Bitte den Entwurf erneut ausdrücklich zur Freigabe einreichen.',
    );
  }
  const currentReviewSnapshotHash = gwgProfessionalReviewSnapshotHash(check);
  if (currentReviewSnapshotHash !== input.reviewSnapshotHash) {
    throw new ActionError(
      'Der angezeigte GwG-Snapshot ist nicht mehr aktuell. Bitte Seite neu laden und alle Angaben erneut prüfen.',
    );
  }
  assertDecisionGate(check, input);
  return currentReviewSnapshotHash;
}

/**
 * Repariert zugleich ältere bzw. noch im GwG-Wurzelordner liegende
 * Nachweise. Personenbezogene Ausweise werden vor der Freigabe immer in
 * GwG/[Name der Person] einsortiert; Rechtsträgernachweise bleiben in GwG.
 */
function verificationFolderDocuments(
  idDocuments: Array<{ type: string; ownerName: string; document: { id: string } | null }>,
): Array<{ documentId: string; personName: string | null }> {
  return idDocuments.flatMap((idDocument) =>
    idDocument.document?.id
      ? [
          {
            documentId: idDocument.document.id,
            personName:
              idDocument.type === 'PERSONALAUSWEIS' || idDocument.type === 'REISEPASS'
                ? idDocument.ownerName
                : null,
          },
        ]
      : [],
  );
}

async function enqueueActivationWelcomeMailTx(
  tx: TxClient,
  input: { tenantId: string; clientId: string; checkId: string; enabled: boolean },
): Promise<void> {
  if (!input.enabled) return;

  // Begrüßungs-Mail an alle Mandanten-Kontakte mit Mail-Opt-in. F-08: im
  // Freigabe-Commit als Versandauftrag; der Worker stellt mit Retry zu.
  await enqueueClientContactsMailTx(
    tx,
    {
      tenantId: input.tenantId,
      clientId: input.clientId,
      purpose: 'gwg-activated',
      resource: { type: 'gwg_check', id: input.checkId },
      staffHref: `/staff/clients/${input.clientId}/gwg`,
    },
    {
      slug: 'gwg-activated',
      vars: {
        portalUrl: `${portalBaseUrl}/portal/dashboard`,
      },
      fallback: {
        subject: 'Willkommen — Ihre Mandantschaft ist nun aktiv',
        bodyMd:
          'Sehr geehrte/r {{contact.fullName}},\n\nIhre Mandantschaft ist jetzt vollständig eingerichtet. Loggen Sie sich gerne in Ihr Mandantenportal ein:\n\n{{portalUrl}}',
      },
    },
  );
}

/**
 * GwG-Verifikation ist die zentrale fachliche Compliance-Entscheidung. Die
 * mandatsbezogene BERUFSTRAEGER-Zuordnung ist maßgeblich; ein angestellter
 * Steuerberater benötigt dafür keine globale ADMIN/PARTNER-Rolle.
 */
export async function verifyCheckTx(
  tx: TxClient,
  input: GwgVerificationInput,
  actor: Pick<GwgStaffActor, 'tenantId' | 'staffId'>,
): Promise<GwgVerificationResult> {
  const { tenantId, staffId } = actor;
  const { checkId, clientId } = input;
  await lockGwgCheckLifecycleTx(tx, { tenantId, clientId });
  // Stable ordering: mandate lifecycle, staff, assignment, staff roles.
  // A concurrent revoke waits until the decision commits or wins before the recheck.
  const isBerufstraeger = await lockStaffGwgReviewerTx(tx, { tenantId, clientId, staffId });
  if (!isBerufstraeger) {
    throw new ActionError(
      'Nur der für diesen Mandanten zugeordnete Berufsträger darf die GwG-Prüfung verifizieren.',
    );
  }

  const check = await tx.gwgCheck.findFirst({
    where: { id: checkId, clientId },
    include: {
      client: {
        select: {
          id: true,
          kind: true,
          name: true,
          street: true,
          postalCode: true,
          city: true,
          countryIso: true,
        },
      },
      beneficialOwners: true,
      representatives: { orderBy: [{ position: 'asc' }, { id: 'asc' }] },
      idDocuments: DECISION_ID_DOCUMENTS_INCLUDE,
    },
  });
  if (!check) throw new ActionError('GwG-Check nicht gefunden.');
  await assertLatestCheckForDecision(tx, { clientId, checkId });
  const currentReviewSnapshotHash = assertVerifiableSnapshot(check, input);
  if (check.riskLevel === null) throw new ActionError('Risikobewertung fehlt.');
  // GWG-SCREENING-001: only the current, fully bound source/person evidence
  // may support a new decision when the optional module is enabled.
  await assertGwgScreeningReadyTx(tx, tenantId, check);

  // Die Begrüßung gehört ausschließlich zur ersten erfolgreichen
  // GwG-Freigabe. Bei einer Wiederholungsprüfung bleibt am Vorgänger der
  // historische verifiedAt-Nachweis erhalten, auch wenn dessen Status
  // inzwischen EXPIRED ist.
  const previousVerificationCount = await tx.gwgCheck.count({
    where: {
      tenantId,
      clientId,
      id: { not: checkId },
      verifiedAt: { not: null },
    },
  });
  const sendActivationWelcome = previousVerificationCount === 0;

  await organizeGwgDocumentsTx(tx, {
    tenantId,
    clientId,
    createdByStaff: staffId,
    documents: verificationFolderDocuments(check.idDocuments),
  });

  const validForDays = riskValidForDays(check.riskLevel);
  const validUntil = new Date(Date.now() + validForDays * 24 * 60 * 60 * 1000);

  // TOCTOU-Schutz: nur aus dem Prüfstatus heraus verifizieren. Verhindert,
  // dass ein bereits REJECTED-Check ohne Neubewertung auf VERIFIED flippt
  // bzw. eine parallele Reject-Entscheidung überschrieben wird.
  const claim = await tx.gwgCheck.updateMany({
    where: { id: checkId, clientId, status: 'IN_REVIEW' },
    data: {
      status: 'VERIFIED',
      verifiedAt: new Date(),
      verifiedBy: staffId,
      validUntil,
      reviewSubmittedAt: check.reviewSubmittedAt,
      reviewSubmittedBy: check.reviewSubmittedBy,
    },
  });
  if (claim.count === 0) {
    throw new ActionError('GwG-Check ist nicht mehr im Prüfstatus — bitte Seite neu laden.');
  }
  // Die Freigabeanforderung ist mit der Entscheidung für alle zuständigen
  // Berufsträger erledigt. Im selben Commit schließen, damit Badge und
  // Dropdown keinen bereits verifizierten Check weiter als offen zeigen.
  await resolveGwgCheckNotificationsTx(tx, {
    tenantId,
    checkId,
  });
  await cancelOpenGwgInvitesTx(tx, {
    tenantId,
    clientId,
    cancelledByStaff: staffId,
  });

  // Mandant scharf schalten — der Trigger erlaubt das jetzt
  await tx.client.update({
    where: { id: clientId },
    data: { allowActive: true },
  });

  await evidenceService.record(tx, {
    tenantId,
    actorType: 'STAFF',
    actorId: staffId,
    action: 'gwg.check.verify',
    resourceType: 'gwg_check',
    resourceId: checkId,
    after: {
      riskLevel: check.riskLevel,
      riskScore: check.riskScore,
      validUntil: validUntil.toISOString(),
      professionalAttestation: true,
      reviewSnapshotHash: currentReviewSnapshotHash,
      reviewSnapshotVersion: 2,
      reviewSubmittedAt: check.reviewSubmittedAt?.toISOString() ?? null,
      reviewSubmittedBy: check.reviewSubmittedBy,
    },
  });
  await enqueueActivationWelcomeMailTx(tx, {
    tenantId,
    clientId,
    checkId,
    enabled: sendActivationWelcome,
  });
  return { validUntil: validUntil.toISOString(), sendActivationWelcome };
}

export interface GwgRejectionInput extends GwgCheckDecisionInput {
  reason: string;
}

/**
 * Ablehnung durch den zugeordneten Berufsträger: beendet die Portal-Sitzungen
 * aller aktiven Kontakte und deaktiviert den Mandanten fail-closed.
 */
export async function rejectCheckTx(
  tx: TxClient,
  input: GwgRejectionInput,
  actor: GwgStaffActor,
): Promise<void> {
  const { tenantId, staffId } = actor;
  const { checkId, clientId, reason } = input;
  await assertClientAccessTx(tx, actor.session, clientId);
  await lockGwgCheckLifecycleTx(tx, { tenantId, clientId });
  const isBerufstraeger = await lockStaffGwgReviewerTx(tx, { tenantId, clientId, staffId });
  if (!isBerufstraeger) {
    throw new ActionError(
      'Nur der für diesen Mandanten zugeordnete Berufsträger darf die GwG-Prüfung ablehnen.',
    );
  }
  await assertLatestCheckForDecision(tx, { clientId, checkId });
  const contactIds = (
    await tx.clientContact.findMany({
      where: { clientId, active: true },
      select: { id: true },
    })
  ).map((c) => c.id);
  for (const contactId of contactIds) {
    await revokeAllSessions('portal', contactId);
  }
  // TOCTOU-Schutz: ein bereits verifizierter Check darf nicht per Race
  // nachträglich abgelehnt werden (sonst allowActive=true trotz Reject).
  const claim = await tx.gwgCheck.updateMany({
    where: { id: checkId, clientId, status: 'IN_REVIEW' },
    data: { status: 'REJECTED', rejectedReason: reason },
  });
  if (claim.count === 0) {
    throw new ActionError('GwG-Check ist nicht mehr zur Entscheidung eingereicht.');
  }
  await resolveGwgCheckNotificationsTx(tx, {
    tenantId,
    checkId,
  });
  await cancelOpenGwgInvitesTx(tx, {
    tenantId,
    clientId,
    cancelledByStaff: staffId,
  });
  await tx.client.updateMany({
    where: { id: clientId, allowActive: true },
    data: { allowActive: false },
  });
  await evidenceService.record(tx, {
    tenantId,
    actorType: 'STAFF',
    actorId: staffId,
    action: 'gwg.check.reject',
    resourceType: 'gwg_check',
    resourceId: checkId,
    after: { reason },
  });
}
