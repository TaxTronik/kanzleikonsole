import { requireStaffPage } from '@/server/auth/staff-page';
import { GwgStructurePanel } from '@/server/mandate-expansion/gwg-structure-panel';
import { withTenantContext } from '@taxtronik/db';
import type { Client, GwgCheck, GwgRepresentative, GwgBeneficialOwner } from '@prisma/client';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, ShieldCheck, AlertTriangle, FileCheck, ChevronRight } from 'lucide-react';
import { Stage } from '@/components/stage';
import { Stepper, withActiveStep } from '@/components/stepper';
import { DEFAULT_FACTORS } from '@/server/gwg/risk-score';
import { RiskAssessmentForm } from './risk-assessment-form';
import { AddIdDocumentForm } from './add-id-doc-form';
import { InviteSection } from './invite-section';
import { GwgDecisionForms } from './decision-forms';
import { fmtDateShort, fmtDateTimeShort } from '@/lib/fmt';
import { identityViewports } from '@/lib/gwg/identity-viewport';
import { DocumentPreviewButton } from '@/components/document-preview';
import type { GwgSubmissionSummaryData } from '@/components/gwg-submission-summary';
import { LegalEntityDetailsForm } from './legal-entity-details-form';
import { NewGwgPersonForm } from './new-gwg-person-form';
import { PersonGeneralForm } from './person-general-form';
import { PersonRolesPanel } from './person-roles-panel';
import { GwgIdentitySubjectsProvider } from './identity-subjects-context';
import { GwgEditStateProvider, GwgLiveStatusBadge } from './edit-state-context';
import { StartCheckCycleForm } from './start-check-cycle-form';
import {
  displaySubjectKeyForAssignment,
  identitySubjectOptions,
  selectableIdentitySubjectOptions,
  type IdentitySubjectOption,
} from '@/server/gwg/identity-subject';
import {
  IdentityDocumentReview,
  type IdentityReviewDocument,
  type IdentityReviewGroup,
} from './identity-document-review';
import { findCleanGwgEvidenceDocumentsTx } from '@/server/gwg/evidence-documents';
import {
  gwgBeneficialOwnerRevision,
  gwgIdentityDocumentSetRevision,
  gwgLegalEntityRevision,
  gwgPersonGeneralRevision,
  gwgRiskRevision,
} from '@/server/gwg/revisions';
import { gwgProfessionalReviewSnapshotHash } from '@/server/gwg/review-snapshot';
import { GWG_CHECK_STATUS_LABELS } from '@/lib/domain-labels';
import { RemoveEvidenceLinkButton } from './remove-evidence-link-button';
import { EvidenceFormToggle } from './evidence-form-toggle';
import {
  isSupersededEvidence,
  personIdentityEvidenceStatus,
  type PersonIdentityEvidenceStatus,
} from './evidence-view-state';

const idTypeLabels: Record<string, string> = {
  PERSONALAUSWEIS: 'Personalausweis',
  REISEPASS: 'Reisepass',
  HANDELSREGISTERAUSZUG: 'Handelsregisterauszug',
  GESELLSCHAFTSVERTRAG: 'Gesellschaftsvertrag',
  VOLLMACHT: 'Vollmacht',
  TRANSPARENZREGISTER_AUSZUG: 'Transparenzregister-Auszug',
  SONSTIGES: 'Sonstiges',
};

const changeScopeLabels: Record<string, string> = {
  LEGACY_UNKNOWN: 'Historische Prüfung (Anlass unbekannt)',
  INITIAL: 'Erstprüfung',
  CLIENT_MASTER_DATA: 'Änderung der Mandantenstammdaten',
  ROUTINE: 'Turnusprüfung',
  BENEFICIAL_OWNERS: 'Änderung wirtschaftlich Berechtigte',
  REPRESENTATIVES: 'Änderung gesetzliche Vertretung',
  BOTH: 'Änderung Berechtigte und Vertretung',
};

const checkStatusLabels: Readonly<Record<string, string>> = {
  ...GWG_CHECK_STATUS_LABELS,
  EXPIRED: 'Abgelaufen/ersetzt',
};

const clientKindLabels: Readonly<Record<string, string>> = {
  NATPERS: 'Natürliche Person',
  JURPERS: 'Juristische Person',
  PERSGES: 'Personengesellschaft',
};

/** Registernachweis-Typen — immer alle als Unterblock (Checklisten-Charakter),
 *  je mit eigener Upload-Fläche (Typ via defaultType voreingestellt). */
const ENTITY_TYPE_BLOCKS = [
  { value: 'HANDELSREGISTERAUSZUG', label: 'Handelsregisterauszug' },
  { value: 'TRANSPARENZREGISTER_AUSZUG', label: 'Transparenzregister-Auszug' },
  { value: 'GESELLSCHAFTSVERTRAG', label: 'Gesellschaftsvertrag / Gründungsnachweis' },
  { value: 'VOLLMACHT', label: 'Vertretungsvollmacht' },
  { value: 'SONSTIGES', label: 'Sonstiger Rechtsträgernachweis' },
] as const;

/** Prüfverlauf: Status als farbige Pill — jede Stufe mit eigener Farbe
 *  (Verifiziert grün, In Prüfung gelb, Abgelehnt rot, Entwurf blau,
 *  Abgelaufen/ersetzt lila). */
function historyStatusBadgeClass(status: string): string {
  switch (status) {
    case 'VERIFIED':
      return 'badge badge-green';
    case 'IN_REVIEW':
      return 'badge badge-yellow';
    case 'REJECTED':
      return 'badge badge-red';
    case 'DRAFT':
      return 'badge badge-brand';
    default:
      return 'badge badge-purple';
  }
}

function isPersonalIdType(type: string): type is 'PERSONALAUSWEIS' | 'REISEPASS' {
  return type === 'PERSONALAUSWEIS' || type === 'REISEPASS';
}

export default async function GwgPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const session = await requireStaffPage();

  const { id: clientId } = await params;
  const { from } = await searchParams;
  const { tenantId, staffId } = session.user;

  const data = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const client = await tx.client.findUnique({ where: { id: clientId } });
      if (!client) return null;
      const [check, clientDocuments, invites, contacts, professionalAssignment, checkHistory] =
        await Promise.all([
          tx.gwgCheck.findFirst({
            where: { clientId },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            include: {
              beneficialOwners: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
              representatives: { orderBy: [{ position: 'asc' }, { id: 'asc' }] },
              idDocuments: {
                orderBy: { createdAt: 'asc' },
                include: {
                  document: {
                    select: {
                      id: true,
                      title: true,
                      createdAt: true,
                      tenantId: true,
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
              },
            },
          }),
          findCleanGwgEvidenceDocumentsTx(tx, {
            tenantId,
            clientId,
            // Kleine Startmenge für schnelle GwG-Seite; der Dateimanager
            // durchsucht ältere Belege bei Eingabe serverseitig vollständig.
            limit: 50,
          }),
          tx.gwgOnboardingInvite.findMany({
            where: { clientId },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 10,
          }),
          tx.clientContact.findMany({
            where: { clientId, active: true },
            select: { id: true, fullName: true, email: true, role: true },
            orderBy: { fullName: 'asc' },
          }),
          tx.clientResponsibility.findFirst({
            where: {
              clientId,
              staffId,
              role: 'BERUFSTRAEGER',
              staff: { tenantId, active: true, isProfessional: true, roles: { some: {} } },
            },
            select: { id: true },
          }),
          tx.gwgCheck.findMany({
            where: { clientId },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 20,
            select: {
              id: true,
              status: true,
              changeScope: true,
              predecessorCheckId: true,
              createdAt: true,
              reviewSubmittedAt: true,
              verifiedAt: true,
              destroyedAt: true,
            },
          }),
        ]);
      const latestInvite = invites[0] ?? null;
      const uploadedIds = Array.isArray(latestInvite?.uploadedDocumentIds)
        ? (latestInvite.uploadedDocumentIds as unknown[]).filter(
            (id): id is string => typeof id === 'string',
          )
        : [];
      const uploadedDocuments =
        uploadedIds.length > 0
          ? await tx.document.findMany({
              where: { clientId, id: { in: uploadedIds } },
              select: { id: true, title: true, createdAt: true },
              orderBy: { createdAt: 'desc' },
            })
          : [];
      return {
        client,
        check,
        clientDocuments,
        invites,
        contacts,
        uploadedDocuments,
        canVerify: professionalAssignment !== null,
        checkHistory,
      };
    },
  );

  if (!data) notFound();
  const {
    client,
    check,
    clientDocuments,
    invites,
    contacts,
    uploadedDocuments,
    canVerify,
    checkHistory,
  } = data;
  const checkHistoryById = new Map(
    checkHistory.map((historyCheck) => [historyCheck.id, historyCheck]),
  );
  const isLegalEntity = client.kind === 'JURPERS' || client.kind === 'PERSGES';
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
  const subjectOptions = check
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
  const identityDocumentGroups = groupIdentityDocuments(identityDocuments ?? [], subjectOptions);
  const supersededIdentityDocumentGroups = groupIdentityDocuments(
    supersededIdentityDocuments,
    subjectOptions,
  );
  const professionalReviewSnapshotHash =
    check?.status === 'IN_REVIEW' ? gwgProfessionalReviewSnapshotHash({ ...check, client }) : null;
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
  const latestInvite = invites[0] ?? null;
  const submittedSummary: GwgSubmissionSummaryData = {
    client: {
      name: client.name,
      kind: client.kind,
      street: client.street,
      postalCode: client.postalCode,
      city: client.city,
      countryIso: client.countryIso,
      allowActive: client.allowActive,
    },
    invite: latestInvite
      ? {
          inviteName: latestInvite.inviteName,
          inviteEmail: latestInvite.inviteEmail,
          status: latestInvite.status,
          createdAt: latestInvite.createdAt.toISOString(),
          expiresAt: latestInvite.expiresAt.toISOString(),
          submittedAt: latestInvite.submittedAt?.toISOString() ?? null,
          cancellationReason: latestInvite.cancellationReason,
        }
      : null,
    owners:
      check?.beneficialOwners.map((o) => ({
        id: o.id,
        fullName: o.fullName,
        birthDate: o.birthDate?.toISOString() ?? null,
        birthPlace: o.birthPlace,
        nationality: o.nationality,
        residence: o.residence,
        ownershipPct: o.ownershipPct?.toString() ?? null,
        isPep: o.isPep,
        notes: o.notes,
      })) ?? [],
    idDocuments:
      check?.idDocuments
        .filter((document) => !isSupersededEvidence(document))
        .map((d) => ({
          id: d.id,
          type: d.type,
          ownerName: d.ownerName,
          number: d.number,
          issuedBy: d.issuedBy,
          issueDate: d.issueDate?.toISOString() ?? null,
          expiryDate: d.expiryDate?.toISOString() ?? null,
          notes: d.notes,
          document: d.document
            ? {
                id: d.document.id,
                title: d.document.title,
                createdAt: d.document.createdAt.toISOString(),
              }
            : null,
        })) ?? [],
    uploadedDocuments: uploadedDocuments.map((d) => ({
      id: d.id,
      title: d.title,
      createdAt: d.createdAt.toISOString(),
    })),
  };

  // Personen-Aggregation (reine Darstellung, keine fachliche Regel): die
  // Subject-Optionen aus dem Server-Modell sind bereits verknüpfungsbereinigt
  // (Vertreter+WB mit explizitem Link = genau eine Person). Dokument-Gruppen
  // werden über ihren persistierten subjectKey der Person zugeordnet.
  const persons = check
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
  const unassignedGroups = identityDocumentGroups.filter((g) => g.subjectKey === null);
  const unassignedOldGroups = supersededIdentityDocumentGroups.filter(
    (group) => group.subjectKey === null,
  );
  const editableCheck = Boolean(
    check &&
    check.status !== 'VERIFIED' &&
    check.status !== 'REJECTED' &&
    check.status !== 'EXPIRED',
  );

  /** Ausweis-Status-Pill pro Person (bestätigt/offen/fehlt). */
  function personAusweisBadgeClass(ausweis: PersonIdentityEvidenceStatus): string {
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
  function personAusweisLabel(ausweis: PersonIdentityEvidenceStatus): string {
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

  // Stepper-Stufen: rein statusgetrieben (keine erfundenen Vollständigkeits-
  // regeln). „Eingereicht" friert Angaben/Dokumente ein; Risiko gilt als
  // erledigt, sobald ein Score gespeichert ist; Entscheidung = VERIFIED.
  const eingereicht =
    Boolean(check?.reviewSubmittedAt) || (check ? check.status !== 'DRAFT' : false);
  const openInvites = invites.filter(
    (i) => i.status === 'PENDING' || i.status === 'STARTED',
  ).length;
  const gwgSteps = gwgProgressSteps(check, isLegalEntity, eingereicht);
  const backLink = gwgBackLink(client.id, from);

  return (
    <GwgEditStateProvider initialStatus={check?.status ?? 'DRAFT'}>
      <GwgIdentitySubjectsProvider initialOptions={subjectOptions}>
        {/* Volle Content-Breite: Personen-Karten und Typ-Unterblöcke liegen
            auf xl zweispaltig — die Seite ist lang genug. */}
        <div className="p-8">
          <div className="flex items-start gap-4 mb-6">
            <Link
              href={backLink.href}
              className="text-disabled hover:text-secondary mt-1"
              aria-label={backLink.label}
              title={backLink.label}
            >
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <div className="flex-1">
              <div className="flex items-center gap-3 mb-1">
                <h1 className="text-2xl font-bold text-primary">GwG-Prüfung</h1>
                {check && <GwgLiveStatusBadge />}
              </div>
              <p className="text-muted text-sm">{client.name}</p>
            </div>
          </div>

          {checkHistory.length > 0 && (
            <details className="card mb-6 p-5">
              <summary className="cursor-pointer text-sm font-semibold text-primary">
                Prüfverlauf ({checkHistory.length})
              </summary>
              <p className="mt-3 text-xs text-muted">
                Angezeigt wird der unveränderliche Startanlass jedes Prüfzyklus. Weitere Änderungen
                innerhalb eines laufenden Zyklus sind im Audit-Protokoll nachvollziehbar.
              </p>
              <ol className="mt-4 space-y-3">
                {checkHistory.map((historyCheck, index) => (
                  <li
                    key={historyCheck.id}
                    className="rounded-md border border-default bg-subtle p-3 text-sm"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium text-primary">
                        Startanlass:{' '}
                        {changeScopeLabels[historyCheck.changeScope] ?? historyCheck.changeScope}
                        {index === 0 ? ' · aktuell' : ''}
                      </span>
                      <span className={historyStatusBadgeClass(historyCheck.status)}>
                        {checkStatusLabels[historyCheck.status] ?? historyCheck.status}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted">
                      Erstellt {fmtDateTimeShort(historyCheck.createdAt)}
                      {historyCheck.reviewSubmittedAt
                        ? ` · eingereicht ${fmtDateTimeShort(historyCheck.reviewSubmittedAt)}`
                        : ''}
                      {historyCheck.verifiedAt
                        ? ` · verifiziert ${fmtDateTimeShort(historyCheck.verifiedAt)}`
                        : ''}
                      {historyCheck.destroyedAt
                        ? ` · vernichtet ${fmtDateTimeShort(historyCheck.destroyedAt)}`
                        : ''}
                    </p>
                    {historyCheck.predecessorCheckId && (
                      <p className="mt-1 text-[11px] text-muted">
                        Vorgänger:{' '}
                        {checkHistoryById.has(historyCheck.predecessorCheckId)
                          ? `${changeScopeLabels[checkHistoryById.get(historyCheck.predecessorCheckId)!.changeScope] ?? 'Prüfung'} vom ${fmtDateShort(checkHistoryById.get(historyCheck.predecessorCheckId)!.createdAt)}`
                          : `Prüfung ${historyCheck.predecessorCheckId.slice(0, 8)}`}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            </details>
          )}

          {isLegalEntity && <GwgMasterData client={client} check={check} />}
          <GwgStructurePanel session={session} clientId={clientId} />

          {check && (
            <div className="card mb-6">
              <div className="p-5">
                <Stepper steps={gwgSteps} />
              </div>
            </div>
          )}

          <div className="mb-6">
            <Stage
              num={1}
              state={check ? gwgSteps[0]!.state : 'active'}
              title="Einladung an den Mandanten"
              sub="Mandant füllt Stammdaten und Ausweis-Fotos selbst aus — ohne Login."
              badge={
                eingereicht ? (
                  <span className="badge badge-green">Eingereicht</span>
                ) : openInvites > 0 ? (
                  <span className="badge badge-yellow">
                    {openInvites} {openInvites === 1 ? 'Einladung' : 'Einladungen'} offen
                  </span>
                ) : (
                  <span className="badge badge-gray">Keine Einladung</span>
                )
              }
            >
              {submittedSummary.invite && (
                <dl className="mb-4 grid grid-cols-1 gap-3 rounded-md border border-default bg-surface-raised p-3 md:grid-cols-3">
                  <div>
                    <dt className="text-xs text-muted">Eingeladen</dt>
                    <dd className="text-sm font-medium text-primary">
                      {submittedSummary.invite.inviteName} · {submittedSummary.invite.inviteEmail}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">Gültig bis</dt>
                    <dd className="text-sm font-medium text-primary">
                      {submittedSummary.invite.expiresAt
                        ? fmtDateTimeShort(new Date(submittedSummary.invite.expiresAt))
                        : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">Übermittelt</dt>
                    <dd className="text-sm font-medium text-primary">
                      {submittedSummary.invite.submittedAt
                        ? fmtDateTimeShort(new Date(submittedSummary.invite.submittedAt))
                        : '—'}
                    </dd>
                  </div>
                </dl>
              )}
              <InviteSection
                clientId={client.id}
                clientName={client.name}
                gwgCheckId={check?.status === 'DRAFT' ? check.id : undefined}
                disabledReason={
                  check && check.status !== 'DRAFT'
                    ? check.status === 'IN_REVIEW'
                      ? 'Die Prüfung ist bereits eingereicht. Änderungen müssen sie zuerst wieder in den Entwurf zurücksetzen.'
                      : 'Starten Sie zuerst unten einen neuen Änderungs- oder Wiederholungszyklus; die Einladung wird anschließend exakt an dessen Entwurf gebunden.'
                    : undefined
                }
                contacts={contacts}
                invites={invites.map((i) => ({
                  id: i.id,
                  inviteName: i.inviteName,
                  inviteEmail: i.inviteEmail,
                  status: i.status,
                  createdAt: i.createdAt.toISOString(),
                  expiresAt: i.expiresAt.toISOString(),
                  submittedAt: i.submittedAt?.toISOString() ?? null,
                }))}
              />
            </Stage>
          </div>

          {check && (
            <div className="mb-6">
              {/* Personen-zentriert: jede Person mit ihren Nachweisen direkt
                unter der Einladung. */}
              <Stage
                state={gwgSteps[1]!.state}
                title="Personen"
                sub="Relevante Personen, ihre Rollen und die zugehörigen Identitätsnachweise."
                badge={
                  <span className="badge badge-gray">
                    {persons.length} {persons.length === 1 ? 'Person' : 'Personen'}
                  </span>
                }
              >
                {editableCheck && (client.kind === 'JURPERS' || client.kind === 'PERSGES') && (
                  <NewGwgPersonForm checkId={check.id} clientId={client.id} />
                )}
                {persons.length === 0 && (
                  <p className="text-sm text-muted">Noch keine Personen erfasst.</p>
                )}
                <div className="space-y-3">
                  {persons.map((person) => (
                    <details
                      key={person.key}
                      className="details-box"
                      open={person.ausweis !== 'bestaetigt'}
                    >
                      <summary>
                        <ChevronRight className="h-4 w-4" />
                        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-primary">
                          {person.name}
                        </span>
                        {person.roles.map((role) => (
                          <span key={role} className="badge badge-brand">
                            {role}
                          </span>
                        ))}
                        {person.isPep && <span className="badge badge-red">PEP</span>}
                        <span className={personAusweisBadgeClass(person.ausweis)}>
                          {personAusweisLabel(person.ausweis)}
                        </span>
                      </summary>
                      <div className="details-body space-y-4 pt-2">
                        <PersonGeneralForm
                          ownerId={person.owner?.id ?? null}
                          representativeId={person.representative?.id ?? null}
                          checkId={check.id}
                          clientId={client.id}
                          value={person.general}
                          revision={person.generalRevision}
                          disabled={!editableCheck}
                        />
                        <IdentityDocumentReview
                          checkId={check.id}
                          clientId={client.id}
                          groups={person.groups}
                          subjectOptions={subjectOptions}
                          clientDocuments={selectableDocuments}
                          defaultSubjectKey={person.key}
                          historicalEvidence={
                            person.oldGroups.length > 0 ? (
                              <HistoricalIdentityGroups groups={person.oldGroups} />
                            ) : undefined
                          }
                          grandfathered={
                            check.status === 'VERIFIED' &&
                            check.identityAssignmentRequired === false
                          }
                          disabled={
                            check.status === 'VERIFIED' ||
                            check.status === 'REJECTED' ||
                            check.status === 'EXPIRED'
                          }
                          reviewMode={check.status === 'IN_REVIEW' && canVerify}
                        />
                        <PersonRolesPanel
                          key={`${person.key}:${gwgLegalEntityRevision(check)}`}
                          checkId={check.id}
                          clientId={client.id}
                          personName={person.name}
                          roleLabels={person.roles.map((role) =>
                            role === 'Vertreter'
                              ? 'Gesetzliche Vertretung'
                              : role.startsWith('WB')
                                ? role.replace('WB', 'Wirtschaftlich berechtigt')
                                : role,
                          )}
                          owner={ownerRoleValue(person.owner)}
                          representativeId={person.representative?.id ?? null}
                          current={{
                            legalForm: check.legalForm,
                            registerNumber: check.registerNumber,
                            registerAuthority: check.registerAuthority,
                            noRegisterEntry: check.noRegisterEntry,
                            representatives: check.representatives.map((representative) => ({
                              id: representative.id,
                              fullName: representative.fullName,
                              position: representative.position,
                              linkedBeneficialOwnerId: representative.linkedBeneficialOwnerId,
                            })),
                            ownershipStructureNotes: check.ownershipStructureNotes,
                          }}
                          currentRevision={gwgLegalEntityRevision(check)}
                          disabled={
                            client.kind === 'NATPERS' ||
                            check.status === 'VERIFIED' ||
                            check.status === 'REJECTED' ||
                            check.status === 'EXPIRED'
                          }
                        />
                      </div>
                    </details>
                  ))}
                </div>

                {unassignedGroups.length > 0 && (
                  <details className="details-box mt-3">
                    <summary>
                      <ChevronRight className="h-4 w-4" />
                      Nicht zugeordnete Nachweise
                      <span className="badge badge-yellow">{unassignedGroups.length}</span>
                    </summary>
                    <div className="details-body">
                      <IdentityDocumentReview
                        checkId={check.id}
                        clientId={client.id}
                        groups={unassignedGroups}
                        subjectOptions={subjectOptions}
                        clientDocuments={selectableDocuments}
                        grandfathered={
                          check.status === 'VERIFIED' && check.identityAssignmentRequired === false
                        }
                        disabled={
                          check.status === 'VERIFIED' ||
                          check.status === 'REJECTED' ||
                          check.status === 'EXPIRED'
                        }
                        reviewMode={check.status === 'IN_REVIEW' && canVerify}
                      />
                    </div>
                  </details>
                )}

                {unassignedOldGroups.length > 0 && (
                  <details className="details-box mt-3">
                    <summary>
                      <ChevronRight className="h-4 w-4" />
                      Alte, nicht zugeordnete Nachweise
                      <span className="badge badge-gray">{unassignedOldGroups.length}</span>
                    </summary>
                    <div className="details-body">
                      <HistoricalIdentityGroups groups={unassignedOldGroups} nested={false} />
                    </div>
                  </details>
                )}
              </Stage>
            </div>
          )}

          {!check ? (
            <div className="card p-8 text-center">
              <ShieldCheck className="h-12 w-12 text-disabled mx-auto mb-4" />
              <h2 className="text-lg font-semibold text-primary mb-2">Noch keine GwG-Prüfung</h2>
              <p className="text-sm text-muted mb-6">
                Sie können die Prüfung selbst starten — oder den Mandanten oben per Einladung
                einladen, die Stammdaten und Ausweise selbst hochzuladen.
              </p>
              <StartCheckCycleForm clientId={client.id} status={null} />
            </div>
          ) : (
            <div className="space-y-6">
              <GwgCheckStatus clientId={client.id} check={check} from={from} contacts={contacts} />

              {check.status === 'IN_REVIEW' && canVerify && (
                <div className="rounded-md border border-blue-300 bg-blue-50 p-4 text-sm text-blue-900 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-100">
                  <p className="font-semibold">Berufsträger-Prüfmodus</p>
                  <p className="mt-1 text-xs">
                    Prüfen Sie jetzt den vollständigen Snapshot von Risikobewertung, Rechtsträger,
                    wirtschaftlich Berechtigten, Vertretung und Nachweisen. Ausweise sind für diese
                    Schlussprüfung aufgeklappt; die Entscheidung am Seitenende wird exakt an diesen
                    Datenstand gebunden und protokolliert.
                  </p>
                </div>
              )}

              {isLegalEntity && (
                <Stage
                  state={gwgSteps[1]!.state}
                  title="Rechtsträger- und Registernachweise"
                  sub="Register-, Gründungs- und Vertretungsnachweise je Dokumenttyp."
                  badge={
                    <span className="badge badge-gray">
                      {(entityDocuments ?? []).length} Nachweise
                    </span>
                  }
                >
                  {/* Jeder Nachweistyp startet eingeklappt und besitzt seine
                      eigene Upload-Fläche. */}
                  <div>
                    <p className="mb-4 text-xs text-muted">
                      Register-/Gründungsnachweis, gegebenenfalls Transparenzregister und
                      Vertretungsvollmachten — ohne Ausweisnummer oder Gültigkeitsdatum.
                    </p>
                    <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-2">
                      {ENTITY_TYPE_BLOCKS.map((block) => {
                        const docs = (entityDocuments ?? []).filter((d) => d.type === block.value);
                        const oldDocs = (supersededEntityDocuments ?? []).filter(
                          (document) => document.type === block.value,
                        );
                        return (
                          <details key={block.value} className="details-box">
                            <summary>
                              <ChevronRight className="h-4 w-4" />
                              <span className="min-w-0 flex-1 text-[13px] font-semibold text-primary">
                                {block.label}
                              </span>
                              <span className="badge badge-gray">{docs.length}</span>
                            </summary>
                            <div className="details-body pt-2">
                              <GwgDocumentList
                                documents={docs}
                                checkId={check.id}
                                clientId={client.id}
                                editable={editableCheck}
                              />
                              {oldDocs.length > 0 && (
                                <details className="mb-4 rounded-md border border-default bg-subtle">
                                  <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-primary">
                                    Alte Nachweise ({oldDocs.length})
                                  </summary>
                                  <div className="border-t border-default p-3">
                                    <GwgDocumentList documents={oldDocs} />
                                  </div>
                                </details>
                              )}
                              {editableCheck && (
                                <EvidenceFormToggle
                                  label={
                                    docs.length > 0 ? 'Nachweis ersetzen' : 'Nachweis hinzufügen'
                                  }
                                >
                                  <AddIdDocumentForm
                                    checkId={check.id}
                                    clientId={client.id}
                                    clientDocuments={selectableDocuments}
                                    variant="entity"
                                    defaultType={block.value}
                                    lockType
                                    replacement={docs.length > 0 ? { mode: 'type' } : undefined}
                                  />
                                </EvidenceFormToggle>
                              )}
                            </div>
                          </details>
                        );
                      })}
                    </div>
                  </div>
                </Stage>
              )}

              {/* Risikobewertung bewusst als LETZTER Schritt vor der Entscheidung:
                die Faktoren (PEP, Struktur) hängen von den erfassten Personen ab —
                jede Personen-/Rechtsträger-Änderung setzt eine gespeicherte
                Bewertung serverseitig zurück (§ 10 Abs. 2 GwG). Stand die
                Bewertung als Schritt 1 oben, lief man im normalen Workflow
                zwangsläufig in diesen Reset. */}
              <Stage
                num={3}
                state={gwgSteps[2]!.state}
                title="Risikobewertung"
                sub="Antworten basierend auf Branche, Sitz, PEP-Status und Geschäftsmodell — als letzter Schritt vor der Entscheidung (Änderungen an Personen oder Rechtsträger setzen eine gespeicherte Bewertung zurück)."
                badge={
                  check.riskLevel ? (
                    <span className="badge badge-yellow">{check.riskLevel}</span>
                  ) : (
                    <span className="badge badge-gray">Offen</span>
                  )
                }
              >
                <RiskAssessmentForm
                  checkId={check.id}
                  clientId={client.id}
                  factors={DEFAULT_FACTORS}
                  currentAnswers={(check.riskAnswers as Record<string, number>) ?? {}}
                  currentScore={check.riskScore ?? null}
                  currentLevel={check.riskLevel ?? null}
                  currentRevision={gwgRiskRevision(check)}
                  disabled={
                    check.status === 'VERIFIED' ||
                    check.status === 'REJECTED' ||
                    check.status === 'EXPIRED'
                  }
                />
              </Stage>

              {/* Verifikation oder Ablehnung */}
              {(check.status === 'DRAFT' || check.status === 'IN_REVIEW') && (
                <Stage
                  num={4}
                  state={gwgSteps[3]!.state}
                  title="Entscheidung"
                  sub="Verifizieren oder ablehnen — begründungspflichtig durch Berufsträger."
                  badge={
                    check.status === 'DRAFT' ? (
                      <span className="badge badge-gray">Entwurf</span>
                    ) : (
                      <span className="badge badge-yellow">In Prüfung</span>
                    )
                  }
                >
                  <GwgDecisionForms
                    checkId={check.id}
                    clientId={client.id}
                    status={check.status}
                    reviewSubmittedAt={check.reviewSubmittedAt?.toISOString() ?? null}
                    canVerify={canVerify}
                    reviewSnapshotHash={professionalReviewSnapshotHash}
                  />
                </Stage>
              )}
            </div>
          )}
        </div>
      </GwgIdentitySubjectsProvider>
    </GwgEditStateProvider>
  );
}

interface DisplayGwgDocument {
  id: string;
  type: string;
  ownerName: string;
  number: string | null;
  expiryDate: Date | null;
  document: { id: string; title: string } | null;
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

function HistoricalIdentityGroups({
  groups,
  nested = true,
}: {
  groups: IdentityReviewGroup[];
  nested?: boolean;
}) {
  const content = (
    <div className="space-y-3">
      {groups.map((group) => {
        const first = group.documents[0]!;
        return (
          <div
            key={group.documentSetId}
            className="rounded-md border border-default bg-surface p-3"
          >
            <p className="text-xs font-semibold text-primary">
              {idTypeLabels[first.type]} · {first.ownerName}
            </p>
            <p className="mt-1 text-xs text-muted">
              {first.number ? `Nr. ${first.number} · ` : ''}
              {first.expiryDate
                ? `gültig bis ${fmtDateShort(new Date(first.expiryDate))}`
                : 'ohne Gültigkeitsdatum'}
            </p>
            <div className="mt-2 space-y-1">
              {group.documents.map((entry) =>
                entry.document ? (
                  <div key={entry.id} className="flex items-center gap-1 text-xs text-muted">
                    <span>{entry.document.title}</span>
                    <DocumentPreviewButton
                      documentId={entry.document.id}
                      documentTitle={entry.document.title}
                    />
                  </div>
                ) : (
                  <p key={entry.id} className="text-xs text-red-700">
                    Datei nicht verfügbar
                  </p>
                ),
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
  if (!nested) return content;
  return (
    <details className="rounded-md border border-default bg-subtle">
      <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-primary">
        Alte Ausweise ({groups.length})
      </summary>
      <div className="border-t border-default p-3">{content}</div>
    </details>
  );
}

function GwgDocumentList({
  documents,
  checkId,
  clientId,
  editable = false,
}: {
  documents: DisplayGwgDocument[];
  checkId?: string;
  clientId?: string;
  editable?: boolean;
}) {
  if (documents.length === 0) {
    return <p className="text-xs text-disabled mb-4">Noch kein Nachweis zugeordnet.</p>;
  }

  return (
    <ul className="divide-y divide-border-subtle mb-4 border border-default rounded-md">
      {documents.map((document) => (
        <li key={document.id} className="px-4 py-3">
          <div className="flex items-center gap-2 mb-1">
            {document.document ? (
              <FileCheck className="h-4 w-4 text-green-600" />
            ) : (
              <AlertTriangle className="h-4 w-4 text-red-600" />
            )}
            <span className="font-medium text-primary">
              {idTypeLabels[document.type] ?? document.type}
            </span>
            {document.expiryDate && document.expiryDate < new Date() && (
              <span className="badge-red">abgelaufen</span>
            )}
            {!document.document && <span className="badge-red">Datei nicht verfügbar</span>}
            {editable && checkId && clientId && (
              <RemoveEvidenceLinkButton
                checkId={checkId}
                clientId={clientId}
                gwgIdDocumentId={document.id}
              />
            )}
          </div>
          {isPersonalIdType(document.type) && (
            <p className="text-xs text-muted ml-6">
              {document.ownerName}
              {document.number ? ` · Nr. ${document.number}` : ''}
              {document.expiryDate ? ` · gültig bis ${fmtDateShort(document.expiryDate)}` : ''}
            </p>
          )}
          {document.document && (
            <div className="flex items-center gap-1 ml-6 mt-1">
              <span className="text-xs text-muted">{document.document.title}</span>
              <DocumentPreviewButton
                documentId={document.document.id}
                documentTitle={document.document.title}
              />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

type GwgDisplayCheck = GwgCheck & { representatives: GwgRepresentative[] };

/** Darstellung unverändert aus der Seite ausgelagert; keine neue Fachentscheidung. */
function GwgMasterData({ client, check }: { client: Client; check: GwgDisplayCheck | null }) {
  return (
    <section className="card mb-6 p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-primary">
            Stammdaten und gesetzliche Vertretung
          </h2>
          <p className="mt-1 text-xs text-muted">
            Die wichtigsten Angaben zum Rechtsträger auf einen Blick.
          </p>
        </div>
        <span className="badge badge-gray">
          {check?.representatives.length ?? 0} gesetzliche Vertretung
          {(check?.representatives.length ?? 0) === 1 ? '' : 'en'}
        </span>
      </div>

      <GwgMasterDataFields client={client} check={check} />

      <div className="mt-5 border-t border-default pt-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
          Gesetzliche Vertreter
        </h3>
        {check?.representatives.length ? (
          <ul className="mt-2 flex flex-wrap gap-2">
            {check.representatives.map((representative) => (
              <li key={representative.id} className="badge badge-brand">
                {representative.fullName}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-muted">Noch keine gesetzliche Vertretung erfasst.</p>
        )}
      </div>

      {check?.ownershipStructureNotes && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
            Eigentums- und Kontrollstruktur
          </h3>
          <p className="mt-1 whitespace-pre-wrap text-sm text-secondary">
            {check.ownershipStructureNotes}
          </p>
        </div>
      )}

      {check && (
        <details className="mt-5 rounded-md border border-default bg-subtle">
          <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-primary">
            Stammdaten bearbeiten
          </summary>
          <div className="border-t border-default p-4">
            <LegalEntityDetailsForm
              key={gwgLegalEntityRevision(check)}
              checkId={check.id}
              clientId={client.id}
              current={{
                legalForm: check.legalForm,
                registerNumber: check.registerNumber,
                registerAuthority: check.registerAuthority,
                noRegisterEntry: check.noRegisterEntry,
                representatives: check.representatives.map((representative) => ({
                  id: representative.id,
                  fullName: representative.fullName,
                  position: representative.position,
                  linkedBeneficialOwnerId: representative.linkedBeneficialOwnerId,
                })),
                ownershipStructureNotes: check.ownershipStructureNotes,
              }}
              currentRevision={gwgLegalEntityRevision(check)}
              disabled={
                check.status === 'VERIFIED' ||
                check.status === 'REJECTED' ||
                check.status === 'EXPIRED'
              }
            />
          </div>
        </details>
      )}
    </section>
  );
}

function GwgMasterDataFields({ client, check }: { client: Client; check: GwgDisplayCheck | null }) {
  const clientAddress = [
    client.street,
    [client.postalCode, client.city].filter(Boolean).join(' '),
    client.countryIso,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <dl className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
      <div>
        <dt className="text-xs text-muted">Name / Firma</dt>
        <dd className="text-sm font-medium text-primary">{client.name}</dd>
      </div>
      <div>
        <dt className="text-xs text-muted">Mandantenart</dt>
        <dd className="text-sm font-medium text-primary">
          {clientKindLabels[client.kind] ?? client.kind}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-muted">Adresse</dt>
        <dd className="text-sm font-medium text-primary">{clientAddress || '—'}</dd>
      </div>
      <div>
        <dt className="text-xs text-muted">Rechtsform</dt>
        <dd className="text-sm font-medium text-primary">{check?.legalForm ?? '—'}</dd>
      </div>
      <div>
        <dt className="text-xs text-muted">Registernummer</dt>
        <dd className="text-sm font-medium text-primary">
          {check?.noRegisterEntry ? 'Kein Registereintrag' : (check?.registerNumber ?? '—')}
        </dd>
      </div>
      <div className="md:col-span-2">
        <dt className="text-xs text-muted">Register / Registergericht</dt>
        <dd className="text-sm font-medium text-primary">
          {check?.noRegisterEntry ? 'Nicht registerpflichtig' : (check?.registerAuthority ?? '—')}
        </dd>
      </div>
    </dl>
  );
}

function GwgCheckStatus({
  clientId,
  check,
  from,
  contacts,
}: {
  clientId: string;
  check: GwgCheck;
  from?: string;
  contacts: Array<{ fullName: string; email: string }>;
}) {
  return (
    <>
      {/* Status-Banner */}
      {check.status === 'VERIFIED' && check.validUntil && (
        <div className="rounded-md bg-green-50 p-4 border border-green-200">
          <div className="flex items-start gap-3">
            <ShieldCheck className="h-5 w-5 text-green-600 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-medium text-green-900">Mandant ist verifiziert.</p>
              <p className="text-xs text-green-700 mt-1">
                Risiko: <strong>{check.riskLevel}</strong> · Gültig bis{' '}
                {fmtDateShort(check.validUntil)}
              </p>
              {from === 'onboarding' && (
                <Link
                  href={`/staff/clients/onboarding/${clientId}?step=poa`}
                  className="btn-primary text-xs mt-3 inline-flex"
                >
                  Im Onboarding weiter
                </Link>
              )}
            </div>
          </div>
        </div>
      )}
      {check.status === 'REJECTED' && (
        <div className="rounded-md bg-red-50 p-4 border border-red-200">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-red-600 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-medium text-red-900">Prüfung abgelehnt.</p>
              {check.rejectedReason && (
                <p className="text-xs text-red-700 mt-1">Begründung: {check.rejectedReason}</p>
              )}
            </div>
          </div>
        </div>
      )}
      {check.status === 'EXPIRED' && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-medium text-amber-900">Prüfung ist abgelaufen.</p>
              <p className="text-xs text-amber-700 mt-1">
                Für die erneute Freigabe ist ein aktueller Prüfsnapshot erforderlich.
              </p>
            </div>
          </div>
        </div>
      )}

      {(check.status === 'VERIFIED' ||
        check.status === 'REJECTED' ||
        check.status === 'EXPIRED') && (
        <section className="card p-5">
          <h2 className="text-sm font-semibold text-primary mb-1">
            {check.status === 'REJECTED' ? 'Korrekturprüfung' : 'Wiederholungsprüfung'}
          </h2>
          <p className="text-xs text-muted mb-4">
            Noch aufbewahrte Identifizierungsangaben werden in einen neuen, bearbeitbaren Entwurf
            übernommen. Gelöschte oder zur Vernichtung vorgemerkte Nachweise werden nicht erneut
            verknüpft. Die alte Pflichtaufzeichnung bleibt unverändert; die Risikobewertung ist
            erneut durchzuführen.
          </p>
          <StartCheckCycleForm
            clientId={clientId}
            checkId={check.id}
            status={check.status}
            contacts={contacts.map((contact) => ({
              fullName: contact.fullName,
              email: contact.email,
            }))}
          />
        </section>
      )}
    </>
  );
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

function gwgBackLink(clientId: string, from?: string) {
  return from === 'onboarding'
    ? { href: `/staff/clients/onboarding/${clientId}?step=gwg`, label: 'Zurück zum Onboarding' }
    : { href: `/staff/clients/${clientId}`, label: 'Zurück zum Mandanten' };
}

function gwgProgressSteps(check: GwgCheck | null, isLegalEntity: boolean, eingereicht: boolean) {
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
          sub: GWG_CHECK_STATUS_LABELS[check.status] ?? check.status,
          done: check.status === 'VERIFIED',
        },
      ])
    : [];
}

function ownerRoleValue(owner: GwgBeneficialOwner | null) {
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
