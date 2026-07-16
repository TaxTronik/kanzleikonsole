import { requireStaffPage } from '@/server/auth/staff-page';
import { withTenantContext } from '@taxtronik/db';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, ShieldCheck, AlertTriangle, FileCheck } from 'lucide-react';
import { DEFAULT_FACTORS } from '@/server/gwg/risk-score';
import { RiskAssessmentForm } from './risk-assessment-form';
import { AddBeneficialOwnerForm } from './add-owner-form';
import { AddIdDocumentForm } from './add-id-doc-form';
import { InviteSection } from './invite-section';
import { GwgDecisionForms } from './decision-forms';
import { fmtDateShort, fmtDateTimeShort } from '@/lib/fmt';
import { DocumentPreviewButton } from '@/components/document-preview';
import {
  GwgSubmissionSummary,
  type GwgSubmissionSummaryData,
} from '@/components/gwg-submission-summary';
import { LegalEntityDetailsForm } from './legal-entity-details-form';
import { BeneficialOwnerForm } from './beneficial-owner-form';
import { GwgIdentitySubjectsProvider } from './identity-subjects-context';
import { GwgEditStateProvider, GwgLiveStatusBadge } from './edit-state-context';
import { StartCheckCycleForm } from './start-check-cycle-form';
import {
  identitySubjectOptions,
  subjectKeyForAssignment,
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
  gwgRiskRevision,
} from '@/server/gwg/revisions';
import { gwgProfessionalReviewSnapshotHash } from '@/server/gwg/review-snapshot';
import { GWG_CHECK_STATUS_LABELS } from '@/lib/domain-labels';

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
              staff: { tenantId, active: true, roles: { some: {} } },
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
        .filter((document) => isPersonalIdType(document.type))
        .map((document) => ({
          ...document,
          type: document.type as 'PERSONALAUSWEIS' | 'REISEPASS',
        }))
    : undefined;
  const entityDocuments = sanitizedDocuments?.filter(
    (document) => !isPersonalIdType(document.type),
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
      vatId: client.vatId,
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
      check?.idDocuments.map((d) => ({
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

  return (
    <GwgEditStateProvider initialStatus={check?.status ?? 'DRAFT'}>
      <div className="p-8 max-w-4xl">
        <div className="flex items-start gap-4 mb-6">
          <Link
            href={
              from === 'onboarding'
                ? `/staff/clients/onboarding/${client.id}?step=gwg`
                : `/staff/clients/${client.id}`
            }
            className="text-disabled hover:text-secondary mt-1"
            aria-label={from === 'onboarding' ? 'Zurück zum Onboarding' : 'Zurück zum Mandanten'}
            title={from === 'onboarding' ? 'Zurück zum Onboarding' : 'Zurück zum Mandanten'}
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

        <div className="mb-6">
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
        </div>

        <div className="mb-6">
          <GwgSubmissionSummary data={submittedSummary} />
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
                    <span className="text-xs text-muted">
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
                        href={`/staff/clients/onboarding/${client.id}?step=poa`}
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
                      <p className="text-xs text-red-700 mt-1">
                        Begründung: {check.rejectedReason}
                      </p>
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
                  Noch aufbewahrte Identifizierungsangaben werden in einen neuen, bearbeitbaren
                  Entwurf übernommen. Gelöschte oder zur Vernichtung vorgemerkte Nachweise werden
                  nicht erneut verknüpft. Die alte Pflichtaufzeichnung bleibt unverändert; die
                  Risikobewertung ist erneut durchzuführen.
                </p>
                <StartCheckCycleForm
                  clientId={client.id}
                  checkId={check.id}
                  status={check.status}
                  contacts={contacts.map((contact) => ({
                    fullName: contact.fullName,
                    email: contact.email,
                  }))}
                />
              </section>
            )}

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

            <GwgIdentitySubjectsProvider initialOptions={subjectOptions}>
              {isLegalEntity && (
                <section className="card p-6">
                  <h2 className="text-lg font-semibold text-primary mb-1">
                    1. Rechtsträger und Vertretung
                  </h2>
                  <p className="text-sm text-muted mb-4">
                    Pflichtangaben nach § 11 Abs. 4 Nr. 2 GwG. Zusätzlich sind unten der
                    Register-/Gründungsnachweis und der Ausweis mindestens einer
                    vertretungsberechtigten Person zuzuordnen. Ein Transparenzregister-Auszug ist
                    nur im Registerfall erforderlich.
                  </p>
                  <LegalEntityDetailsForm
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
                    knownPeople={[
                      ...contacts.map((contact) => ({
                        key: `contact:${contact.id}`,
                        fullName: contact.fullName,
                        sourceLabel: `${contact.role?.trim() || 'Mandantenkontakt'} · ${contact.email}`,
                      })),
                      ...check.beneficialOwners.map((owner, index) => ({
                        key: `owner:${owner.id}`,
                        fullName: owner.fullName,
                        beneficialOwnerId: owner.id,
                        sourceLabel: `Wirtschaftlich berechtigt${
                          owner.birthDate
                            ? ` · geb. ${new Intl.DateTimeFormat('de-DE', {
                                day: '2-digit',
                                month: '2-digit',
                                year: 'numeric',
                                timeZone: 'UTC',
                              }).format(owner.birthDate)}`
                            : ''
                        } · Eintrag ${index + 1}`,
                      })),
                    ]}
                    currentRevision={gwgLegalEntityRevision(check)}
                    disabled={
                      check.status === 'VERIFIED' ||
                      check.status === 'REJECTED' ||
                      check.status === 'EXPIRED'
                    }
                  />

                  <div className="mt-6 border-t border-default pt-5">
                    <div className="mb-3">
                      <div>
                        <h3 className="text-sm font-semibold text-primary">
                          Rechtsträgernachweise
                        </h3>
                        <p className="text-xs text-muted mt-1">
                          Register-/Gründungsnachweis, gegebenenfalls Transparenzregister und
                          Vertretungsvollmachten gehören hierher — ohne Ausweisnummer oder
                          Gültigkeitsdatum.
                        </p>
                      </div>
                    </div>
                    <GwgDocumentList documents={entityDocuments ?? []} />
                    {check.status !== 'VERIFIED' &&
                      check.status !== 'REJECTED' &&
                      check.status !== 'EXPIRED' && (
                        <AddIdDocumentForm
                          checkId={check.id}
                          clientId={client.id}
                          clientDocuments={selectableDocuments}
                          variant="entity"
                        />
                      )}
                  </div>
                </section>
              )}

              {/* Schritt 2: Wirtschaftlich Berechtigte */}
              <section className="card p-6">
                <h2 className="text-lg font-semibold text-primary mb-1">
                  {isLegalEntity ? '2' : '1'}. Wirtschaftlich Berechtigte
                </h2>
                <p className="text-sm text-muted mb-4">
                  Personen mit mehr als 25 % Anteil oder vergleichbarer Kontrolle (§ 3 GwG).
                </p>

                {check.beneficialOwners.length > 0 && (
                  <ul className="divide-y divide-border-subtle mb-4 border border-default rounded-md">
                    {check.beneficialOwners.map((o) => (
                      <li key={o.id} className="px-4 py-3 flex items-center justify-between">
                        {check.status === 'DRAFT' || check.status === 'IN_REVIEW' ? (
                          <BeneficialOwnerForm
                            ownerId={o.id}
                            checkId={check.id}
                            clientId={client.id}
                            value={{
                              fullName: o.fullName,
                              birthDate: o.birthDate?.toISOString().slice(0, 10) ?? '',
                              birthPlace: o.birthPlace ?? '',
                              residence: o.residence ?? '',
                              nationality: o.nationality ?? '',
                              ownershipPct: o.ownershipPct?.toString() ?? '',
                              isPep: o.isPep,
                            }}
                            revision={gwgBeneficialOwnerRevision(o)}
                          />
                        ) : (
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-primary">{o.fullName}</span>
                              {o.isPep && <span className="badge-red">PEP</span>}
                            </div>
                            <p className="text-xs text-muted">
                              {o.ownershipPct ? `${Number(o.ownershipPct).toFixed(2)} % · ` : ''}
                              {o.nationality ?? ''}
                              {o.residence ? ` · ${o.residence}` : ''}
                            </p>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}

                {check.status !== 'VERIFIED' &&
                  check.status !== 'REJECTED' &&
                  check.status !== 'EXPIRED' && (
                    <AddBeneficialOwnerForm checkId={check.id} clientId={client.id} />
                  )}
              </section>

              {/* Schritt 3: Identitätsdokumente */}
              <section className="card p-6">
                <div className="mb-4">
                  <div>
                    <h2 className="text-lg font-semibold text-primary mb-1">
                      {isLegalEntity ? '3' : '2'}. Identitätsdokumente
                    </h2>
                    <p className="text-sm text-muted">
                      Vorder- und Rückseite gemeinsam ansehen, die erfasste Person eindeutig
                      zuordnen und die ausgelesenen Angaben direkt darunter korrigieren oder
                      bestätigen.
                    </p>
                  </div>
                </div>

                <IdentityDocumentReview
                  checkId={check.id}
                  clientId={client.id}
                  groups={identityDocumentGroups}
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

                {check.status !== 'VERIFIED' &&
                  check.status !== 'REJECTED' &&
                  check.status !== 'EXPIRED' && (
                    <AddIdDocumentForm
                      checkId={check.id}
                      clientId={client.id}
                      clientDocuments={selectableDocuments}
                      variant="identity"
                      subjectOptions={subjectOptions}
                    />
                  )}
              </section>
            </GwgIdentitySubjectsProvider>

            {/* Risikobewertung bewusst als LETZTER Schritt vor der Entscheidung:
                die Faktoren (PEP, Struktur) hängen von den erfassten Personen ab —
                jede Personen-/Rechtsträger-Änderung setzt eine gespeicherte
                Bewertung serverseitig zurück (§ 10 Abs. 2 GwG). Stand die
                Bewertung als Schritt 1 oben, lief man im normalen Workflow
                zwangsläufig in diesen Reset. */}
            <section className="card p-6">
              <h2 className="text-lg font-semibold text-primary mb-1">
                {isLegalEntity ? '4' : '3'}. Risikobewertung
              </h2>
              <p className="text-sm text-muted mb-4">
                Antworten basierend auf Branche, Sitz, PEP-Status und Geschäftsmodell. Als letzter
                Schritt, nachdem alle Personen erfasst sind — Änderungen an Personen oder
                Rechtsträger setzen eine gespeicherte Bewertung zurück.
              </p>
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
            </section>

            {/* Verifikation oder Ablehnung */}
            {(check.status === 'DRAFT' || check.status === 'IN_REVIEW') && (
              <section className="card p-6">
                <h2 className="text-lg font-semibold text-primary mb-3">
                  {isLegalEntity ? '5' : '4'}. Entscheidung
                </h2>
                <GwgDecisionForms
                  checkId={check.id}
                  clientId={client.id}
                  status={check.status}
                  reviewSubmittedAt={check.reviewSubmittedAt?.toISOString() ?? null}
                  canVerify={canVerify}
                  reviewSnapshotHash={professionalReviewSnapshotHash}
                />
              </section>
            )}
          </div>
        )}
      </div>
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
      document: document.document,
    });
    groups.set(groupingKey, current);
  }

  return [...groups.values()].map((entries) => {
    const first = entries[0]!;
    const persistedSubjectKey = subjectKeyForAssignment({
      naturalClientSubjectId: first.naturalClientSubjectId,
      beneficialOwnerSubjectId: first.beneficialOwnerSubjectId,
      representativeSubjectId: first.representativeSubjectId,
    });
    return {
      key: first.documentSetId,
      documentSetId: first.documentSetId,
      documents: entries,
      subjectKey:
        persistedSubjectKey && subjects.some((subject) => subject.key === persistedSubjectKey)
          ? persistedSubjectKey
          : null,
      revision: gwgIdentityDocumentSetRevision(entries),
    };
  });
}

function GwgDocumentList({ documents }: { documents: DisplayGwgDocument[] }) {
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
