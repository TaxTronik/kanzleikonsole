import type { GwgCheck, GwgRepresentative, GwgBeneficialOwner } from '@prisma/client';
import { withActiveStep } from '@/components/stepper';
import { fmtDateShort } from '@/lib/fmt';
import { identityViewports } from '@/lib/gwg/identity-viewport';
import {
  displaySubjectKeyForAssignment,
  identitySubjectOptions,
  selectableIdentitySubjectOptions,
  type IdentitySubjectOption,
} from '@/server/gwg/identity-subject';
import {
  gwgIdentityDocumentSetRevision,
  gwgPersonGeneralRevision,
  gwgBeneficialOwnerRevision,
} from '@/server/gwg/revisions';
import { GWG_CHECK_STATUS_LABELS } from '@/lib/domain-labels';
import type { IdentityReviewDocument, IdentityReviewGroup } from './identity-document-review';
import {
  isSupersededEvidence,
  personIdentityEvidenceStatus,
  type PersonIdentityEvidenceStatus,
} from './evidence-view-state';
import { isPersonalIdType } from './gwg-page-labels';
import type { GwgPageData, GwgPageCheck } from './gwg-page-data';

/** Current usability is distinct from the historical persisted decision. No status is written. */
export function gwgPageAvailability(check: GwgCheck | null, now = new Date()) {
  const destroyed = Boolean(check?.destroyedAt);
  const expired =
    check?.status === 'EXPIRED' ||
    Boolean(check?.status === 'VERIFIED' && check.validUntil && check.validUntil <= now);
  const editable = Boolean(
    check && !destroyed && (check.status === 'DRAFT' || check.status === 'IN_REVIEW'),
  );
  const displayStatus = destroyed
    ? 'Vernichtet'
    : expired
      ? 'Abgelaufen/ersetzt'
      : check
        ? (GWG_CHECK_STATUS_LABELS[check.status] ?? check.status)
        : '';
  return { destroyed, expired, editable, displayStatus };
}

export function buildGwgPageModel(data: GwgPageData, now = new Date()) {
  const { client, check, invites } = data;
  const availability = gwgPageAvailability(check, now);
  // A retention skeleton must not reconstruct natural-person fields from the current client.
  const visibleCheck = availability.destroyed ? null : check;
  const subjectOptions = buildSubjectOptions(visibleCheck, client);
  const evidence = buildEvidenceModel(
    visibleCheck,
    data.clientDocuments,
    client,
    subjectOptions,
    data.tenantId,
  );
  const persons = buildPersons(
    visibleCheck,
    subjectOptions,
    evidence.identityDocumentGroups,
    evidence.supersededIdentityDocumentGroups,
  );
  const eingereicht =
    Boolean(check?.reviewSubmittedAt) || (check ? check.status !== 'DRAFT' : false);
  const isLegalEntity = client.kind === 'JURPERS' || client.kind === 'PERSGES';
  return {
    ...availability,
    ...evidence,
    client,
    check,
    subjectOptions,
    persons,
    eingereicht,
    isLegalEntity,
    openInvites: invites.filter(
      (invite) => invite.status === 'PENDING' || invite.status === 'STARTED',
    ).length,
    latestInvite: invites[0] ?? null,
    gwgSteps: gwgProgressSteps(check, isLegalEntity, eingereicht, availability.displayStatus),
    unassignedGroups: evidence.identityDocumentGroups.filter((group) => group.subjectKey === null),
    unassignedOldGroups: evidence.supersededIdentityDocumentGroups.filter(
      (group) => group.subjectKey === null,
    ),
  };
}
export type GwgPageModel = ReturnType<typeof buildGwgPageModel>;

function buildSubjectOptions(check: GwgPageCheck | null, client: GwgPageData['client']) {
  return check
    ? identitySubjectOptions({
        clientId: client.id,
        clientName: client.name,
        clientKind: client.kind,
        representatives: check.representatives.map((representative) => ({
          id: representative.id,
          fullName: representative.fullName,
          position: representative.position,
          linkedBeneficialOwnerId: representative.linkedBeneficialOwnerId,
        })),
        beneficialOwners: check.beneficialOwners.map((owner) => ({
          id: owner.id,
          fullName: owner.fullName,
          birthDate: owner.birthDate,
        })),
      })
    : [];
}
function buildEvidenceModel(
  check: GwgPageCheck | null,
  clientDocuments: GwgPageData['clientDocuments'],
  client: GwgPageData['client'],
  subjectOptions: IdentitySubjectOption[],
  tenantId: string,
) {
  const clientId = client.id;
  const sanitizedDocuments = check?.idDocuments.map((entry) => {
    const document = entry.document;
    const available =
      document !== null &&
      document.tenantId === tenantId &&
      document.clientId === clientId &&
      document.classification === 'GWG_EVIDENCE' &&
      document.deletedAt === null &&
      document.gwgDestructionRequestedAt === null &&
      document.gwgDestroyedAt === null &&
      document.versions.length === 1 &&
      document.versions[0]?.scanStatus === 'CLEAN' &&
      document.versions[0].scanCompletedAt !== null;
    return {
      ...entry,
      document: available
        ? {
            id: document.id,
            title: document.title,
            createdAt: document.createdAt.toISOString(),
          }
        : null,
    };
  });
  const identityDocuments = sanitizedDocuments
    ? sanitizedDocuments
        .filter((document) => !isSupersededEvidence(document) && isPersonalIdType(document.type))
        .map((document) => ({
          ...document,
          type: document.type as 'PERSONALAUSWEIS' | 'REISEPASS',
        }))
    : undefined;
  const entityDocuments = sanitizedDocuments?.filter(
    (document) => !isSupersededEvidence(document) && !isPersonalIdType(document.type),
  );
  const supersededIdentityDocuments = sanitizedDocuments
    ? sanitizedDocuments
        .filter((document) => isSupersededEvidence(document) && isPersonalIdType(document.type))
        .map((document) => ({
          ...document,
          type: document.type as 'PERSONALAUSWEIS' | 'REISEPASS',
        }))
    : [];
  const supersededEntityDocuments = sanitizedDocuments?.filter(
    (document) => isSupersededEvidence(document) && !isPersonalIdType(document.type),
  );
  const identityDocumentGroups = groupIdentityDocuments(identityDocuments ?? [], subjectOptions);
  const supersededIdentityDocumentGroups = groupIdentityDocuments(
    supersededIdentityDocuments,
    subjectOptions,
  );
  const linkedDocumentIds = new Set(
    check?.idDocuments
      .map((document) => document.documentId)
      .filter((documentId): documentId is string => documentId !== null) ?? [],
  );
  const selectableDocuments = clientDocuments
    .filter((document) => !linkedDocumentIds.has(document.id))
    .map((document) => ({
      id: document.id,
      title: document.title,
      createdAt: document.createdAt.toISOString(),
    }));

  return {
    identityDocumentGroups,
    supersededIdentityDocumentGroups,
    entityDocuments,
    supersededEntityDocuments,
    selectableDocuments,
  };
}
function buildPersons(
  check: GwgPageCheck | null,
  subjectOptions: IdentitySubjectOption[],
  identityDocumentGroups: IdentityReviewGroup[],
  supersededIdentityDocumentGroups: IdentityReviewGroup[],
) {
  // Personen-Aggregation (reine Darstellung, keine fachliche Regel): die
  // Subject-Optionen aus dem Server-Modell sind bereits verknüpfungsbereinigt
  // (Vertreter+WB mit explizitem Link = genau eine Person). Dokument-Gruppen
  // werden über ihren persistierten subjectKey der Person zugeordnet.
  return check
    ? selectableIdentitySubjectOptions(subjectOptions).map((subject) => {
        const owner =
          subject.kind === 'BENEFICIAL_OWNER'
            ? (check.beneficialOwners.find((o) => o.id === subject.id) ?? null)
            : subject.linkedBeneficialOwnerId
              ? (check.beneficialOwners.find((o) => o.id === subject.linkedBeneficialOwnerId) ??
                null)
              : null;
        const representative =
          subject.kind === 'REPRESENTATIVE'
            ? (check.representatives.find((entry) => entry.id === subject.id) ?? null)
            : subject.linkedRepresentativeId
              ? (check.representatives.find(
                  (entry) => entry.id === subject.linkedRepresentativeId,
                ) ?? null)
              : null;
        const roles = subject.roles.map((role) => {
          if (role === 'VERTRETUNGSBERECHTIGT') return 'Vertreter';
          if (role === 'WIRTSCHAFTLICH_BERECHTIGT')
            return owner?.ownershipPct ? `WB ${Number(owner.ownershipPct).toFixed(0)} %` : 'WB';
          return 'Mandant';
        });
        const groups = identityDocumentGroups.filter((g) => g.subjectKey === subject.key);
        const oldGroups = supersededIdentityDocumentGroups.filter(
          (group) => group.subjectKey === subject.key,
        );
        const ausweis = personIdentityEvidenceStatus(groups);
        const generalSource = owner ?? representative;
        const general = personGeneralData(generalSource, subject.name);
        return {
          key: subject.key,
          name: general.fullName,
          roles,
          isPep: general.isPep === true,
          owner,
          representative,
          general,
          generalRevision: gwgPersonGeneralRevision({
            ...general,
            birthDate: generalSource?.birthDate ?? null,
          }),
          groups,
          oldGroups,
          ausweis,
        };
      })
    : [];
}
interface IdentityDocumentSource {
  id: string;
  gwgCheckId: string;
  documentSetId: string;
  documentId: string | null;
  type: 'PERSONALAUSWEIS' | 'REISEPASS';
  ownerName: string;
  number: string | null;
  issuedBy: string | null;
  issueDate: Date | null;
  expiryDate: Date | null;
  verifiedAt: Date | null;
  naturalClientSubjectId: string | null;
  beneficialOwnerSubjectId: string | null;
  representativeSubjectId: string | null;
  identityAssignmentConfirmedAt: Date | null;
  identityAssignmentConfirmedBy: string | null;
  notes: string | null;
  viewports?: unknown;
  document: { id: string; title: string; createdAt: string } | null;
}

function groupIdentityDocuments(
  documents: IdentityDocumentSource[],
  subjects: IdentitySubjectOption[],
): IdentityReviewGroup[] {
  const groups = new Map<string, IdentityReviewDocument[]>();

  for (const document of documents) {
    // Nur die persistierte Satz-ID darf Dateien verbinden. Weder Name noch
    // Ausweisnummer oder Onboarding-Notiz sind eine eindeutige Identität.
    const groupingKey = document.documentSetId;
    const current = groups.get(groupingKey) ?? [];
    current.push({
      id: document.id,
      gwgCheckId: document.gwgCheckId,
      documentSetId: document.documentSetId,
      documentId: document.documentId,
      type: document.type,
      ownerName: document.ownerName,
      number: document.number,
      issuedBy: document.issuedBy,
      issueDate: document.issueDate?.toISOString().slice(0, 10) ?? null,
      expiryDate: document.expiryDate?.toISOString().slice(0, 10) ?? null,
      verifiedAt: document.verifiedAt?.toISOString() ?? null,
      naturalClientSubjectId: document.naturalClientSubjectId,
      beneficialOwnerSubjectId: document.beneficialOwnerSubjectId,
      representativeSubjectId: document.representativeSubjectId,
      identityAssignmentConfirmedAt: document.identityAssignmentConfirmedAt?.toISOString() ?? null,
      identityAssignmentConfirmedBy: document.identityAssignmentConfirmedBy,
      notes: document.notes,
      viewports: identityViewports(document.viewports),
      document: document.document,
    });
    groups.set(groupingKey, current);
  }

  return [...groups.values()].map((entries) => {
    const first = entries[0]!;
    const displaySubjectKey = displaySubjectKeyForAssignment(
      {
        naturalClientSubjectId: first.naturalClientSubjectId,
        beneficialOwnerSubjectId: first.beneficialOwnerSubjectId,
        representativeSubjectId: first.representativeSubjectId,
      },
      subjects,
    );
    return {
      key: first.documentSetId,
      documentSetId: first.documentSetId,
      documents: entries,
      subjectKey: displaySubjectKey,
      // Bind CAS to the stored values; rendering normalizes legacy null views to [].
      revision: gwgIdentityDocumentSetRevision(
        documents.filter((document) => document.documentSetId === first.documentSetId),
      ),
    };
  });
}

function personGeneralData(
  generalSource: GwgBeneficialOwner | GwgRepresentative | null,
  fallbackName: string,
) {
  return {
    fullName: generalSource?.fullName ?? fallbackName,
    birthDate: generalSource?.birthDate?.toISOString().slice(0, 10) ?? '',
    birthPlace: generalSource?.birthPlace ?? '',
    residence: generalSource?.residence ?? '',
    nationality: generalSource?.nationality ?? '',
    isPep: generalSource?.isPep ?? null,
  };
}

export function ownerRoleValue(owner: GwgBeneficialOwner | null) {
  return owner
    ? {
        id: owner.id,
        fullName: owner.fullName,
        birthDate: owner.birthDate?.toISOString().slice(0, 10) ?? '',
        birthPlace: owner.birthPlace ?? '',
        residence: owner.residence ?? '',
        nationality: owner.nationality ?? '',
        ownershipPct: owner.ownershipPct?.toString() ?? '',
        isPep: owner.isPep,
        revision: gwgBeneficialOwnerRevision(owner),
      }
    : null;
}

/** Ausweis-Status-Pill pro Person (bestätigt/offen/fehlt). */
export function personAusweisBadgeClass(ausweis: PersonIdentityEvidenceStatus): string {
  return ausweis === 'bestaetigt'
    ? 'badge badge-green'
    : ausweis === 'mehrfach'
      ? 'badge badge-red'
      : ausweis === 'abgelaufen'
        ? 'badge badge-red'
        : ausweis === 'offen'
          ? 'badge badge-yellow'
          : 'badge badge-gray';
}
export function personAusweisLabel(ausweis: PersonIdentityEvidenceStatus): string {
  return ausweis === 'bestaetigt'
    ? 'Ausweis bestätigt'
    : ausweis === 'mehrfach'
      ? 'Mehrere aktive Ausweise'
      : ausweis === 'abgelaufen'
        ? 'Ausweis abgelaufen'
        : ausweis === 'offen'
          ? 'Prüfung offen'
          : 'Ausweis fehlt';
}

export function gwgProgressSteps(
  check: GwgCheck | null,
  isLegalEntity: boolean,
  eingereicht: boolean,
  displayStatus: string,
) {
  return check
    ? withActiveStep([
        {
          label: 'Einladung',
          sub: check.reviewSubmittedAt
            ? `eingereicht ${fmtDateShort(check.reviewSubmittedAt)}`
            : 'offen',
          done: eingereicht,
        },
        {
          label: 'Angaben & Nachweise',
          sub: isLegalEntity ? 'Rechtsträger & Personen' : 'Personen',
          done: eingereicht,
        },
        {
          label: 'Risikobewertung',
          sub: check.riskLevel ?? 'offen',
          done: check.riskScore != null,
        },
        {
          label: 'Entscheidung',
          sub: displayStatus,
          done: displayStatus === GWG_CHECK_STATUS_LABELS.VERIFIED,
        },
      ])
    : [];
}
