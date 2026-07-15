import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, ShieldCheck, AlertTriangle, FileCheck } from 'lucide-react';
import { DEFAULT_FACTORS } from '@/server/gwg/risk-score';
import { RiskAssessmentForm } from './risk-assessment-form';
import { AddBeneficialOwnerForm } from './add-owner-form';
import { AddIdDocumentForm } from './add-id-doc-form';
import { InviteSection } from './invite-section';
import { GwgDecisionForms } from './decision-forms';
import { fmtDateShort } from '@/lib/fmt';
import { DocumentPreviewButton } from '@/components/document-preview';
import {
  GwgSubmissionSummary,
  type GwgSubmissionSummaryData,
} from '@/components/gwg-submission-summary';
import { LegalEntityDetailsForm } from './legal-entity-details-form';
import { DocumentUploadButton } from '@/components/document-upload-button';
import { BeneficialOwnerForm } from './beneficial-owner-form';
import { StartCheckCycleForm } from './start-check-cycle-form';

const statusLabels: Record<string, string> = {
  DRAFT: 'Entwurf',
  IN_REVIEW: 'In Prüfung',
  VERIFIED: 'Verifiziert',
  REJECTED: 'Abgelehnt',
  EXPIRED: 'Abgelaufen',
};

const idTypeLabels: Record<string, string> = {
  PERSONALAUSWEIS: 'Personalausweis',
  REISEPASS: 'Reisepass',
  HANDELSREGISTERAUSZUG: 'Handelsregisterauszug',
  GESELLSCHAFTSVERTRAG: 'Gesellschaftsvertrag',
  VOLLMACHT: 'Vollmacht',
  TRANSPARENZREGISTER_AUSZUG: 'Transparenzregister-Auszug',
  SONSTIGES: 'Sonstiges',
};

function isPersonalIdType(type: string): boolean {
  return type === 'PERSONALAUSWEIS' || type === 'REISEPASS';
}

export default async function GwgPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');

  const { id: clientId } = await params;
  const { from } = await searchParams;
  const { tenantId, staffId } = session.user;

  const data = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const client = await tx.client.findUnique({ where: { id: clientId } });
      if (!client) return null;
      const [check, clientDocuments, invites, contacts, professionalAssignment] = await Promise.all(
        [
          tx.gwgCheck.findFirst({
            where: { clientId },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            include: {
              beneficialOwners: { orderBy: { createdAt: 'asc' } },
              idDocuments: {
                orderBy: { createdAt: 'asc' },
                include: {
                  document: {
                    select: { id: true, title: true, createdAt: true, classification: true },
                  },
                },
              },
            },
          }),
          tx.document.findMany({
            where: { clientId, classification: 'GWG_EVIDENCE', deletedAt: null },
            select: { id: true, title: true },
            orderBy: { createdAt: 'desc' },
            take: 200,
          }),
          tx.gwgOnboardingInvite.findMany({
            where: { clientId },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 10,
          }),
          tx.clientContact.findMany({
            where: { clientId, active: true },
            select: { fullName: true, email: true },
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
        ],
      );
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
      };
    },
  );

  if (!data) notFound();
  const { client, check, clientDocuments, invites, contacts, uploadedDocuments, canVerify } = data;
  const isLegalEntity = client.kind === 'JURPERS' || client.kind === 'PERSGES';
  const identityDocuments = check?.idDocuments.filter((document) =>
    isPersonalIdType(document.type),
  );
  const entityDocuments = check?.idDocuments.filter((document) => !isPersonalIdType(document.type));
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
            {check && (
              <span
                className={
                  check.status === 'VERIFIED'
                    ? 'badge-green'
                    : check.status === 'REJECTED' || check.status === 'EXPIRED'
                      ? 'badge-red'
                      : 'badge-yellow'
                }
              >
                {statusLabels[check.status]}
              </span>
            )}
          </div>
          <p className="text-muted text-sm">{client.name}</p>
        </div>
      </div>

      <div className="mb-6">
        <InviteSection
          clientId={client.id}
          clientName={client.name}
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

      {!check ? (
        <div className="card p-8 text-center">
          <ShieldCheck className="h-12 w-12 text-disabled mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-primary mb-2">Noch keine GwG-Prüfung</h2>
          <p className="text-sm text-muted mb-6">
            Sie können die Prüfung selbst starten — oder den Mandanten oben per Einladung einladen,
            die Stammdaten und Ausweise selbst hochzuladen.
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
                Noch aufbewahrte Identifizierungsangaben werden in einen neuen, bearbeitbaren
                Entwurf übernommen. Gelöschte oder zur Vernichtung vorgemerkte Nachweise werden
                nicht erneut verknüpft. Die alte Pflichtaufzeichnung bleibt unverändert; die
                Risikobewertung ist erneut durchzuführen.
              </p>
              <StartCheckCycleForm clientId={client.id} checkId={check.id} status={check.status} />
            </section>
          )}

          {/* Schritt 1: Risikobewertung */}
          <section className="card p-6">
            <h2 className="text-lg font-semibold text-primary mb-1">1. Risikobewertung</h2>
            <p className="text-sm text-muted mb-4">
              Antworten basierend auf Branche, Sitz, PEP-Status und Geschäftsmodell.
            </p>
            <RiskAssessmentForm
              checkId={check.id}
              clientId={client.id}
              factors={DEFAULT_FACTORS}
              currentAnswers={(check.riskAnswers as Record<string, number>) ?? {}}
              currentScore={check.riskScore ?? null}
              currentLevel={check.riskLevel ?? null}
              disabled={
                check.status === 'VERIFIED' ||
                check.status === 'REJECTED' ||
                check.status === 'EXPIRED'
              }
            />
          </section>

          {isLegalEntity && (
            <section className="card p-6">
              <h2 className="text-lg font-semibold text-primary mb-1">
                2. Rechtsträger und Vertretung
              </h2>
              <p className="text-sm text-muted mb-4">
                Pflichtangaben nach § 11 Abs. 4 Nr. 2 GwG. Zusätzlich sind unten der
                Register-/Gründungsnachweis und der Ausweis mindestens einer vertretungsberechtigten
                Person zuzuordnen. Ein Transparenzregister-Auszug ist nur im Registerfall
                erforderlich.
              </p>
              <LegalEntityDetailsForm
                checkId={check.id}
                clientId={client.id}
                current={{
                  legalForm: check.legalForm,
                  registerNumber: check.registerNumber,
                  registerAuthority: check.registerAuthority,
                  noRegisterEntry: check.noRegisterEntry,
                  representativeNames: check.representativeNames,
                  ownershipStructureNotes: check.ownershipStructureNotes,
                }}
                disabled={
                  check.status === 'VERIFIED' ||
                  check.status === 'REJECTED' ||
                  check.status === 'EXPIRED'
                }
              />

              <div className="mt-6 border-t border-default pt-5">
                <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
                  <div>
                    <h3 className="text-sm font-semibold text-primary">Rechtsträgernachweise</h3>
                    <p className="text-xs text-muted mt-1">
                      Register-/Gründungsnachweis, gegebenenfalls Transparenzregister und
                      Vertretungsvollmachten gehören hierher — ohne Ausweisnummer oder
                      Gültigkeitsdatum.
                    </p>
                  </div>
                  {check.status !== 'VERIFIED' &&
                    check.status !== 'REJECTED' &&
                    check.status !== 'EXPIRED' && (
                      <DocumentUploadButton
                        clientId={client.id}
                        defaultClassification="GWG_EVIDENCE"
                        buttonLabel="Nachweis hochladen"
                        buttonClassName="btn-secondary text-xs"
                      />
                    )}
                </div>
                <GwgDocumentList documents={entityDocuments ?? []} />
                {check.status !== 'VERIFIED' &&
                  check.status !== 'REJECTED' &&
                  check.status !== 'EXPIRED' && (
                    <AddIdDocumentForm
                      checkId={check.id}
                      clientId={client.id}
                      clientName={client.name}
                      clientDocuments={clientDocuments}
                      variant="entity"
                    />
                  )}
              </div>
            </section>
          )}

          {/* Schritt 2: Wirtschaftlich Berechtigte */}
          <section className="card p-6">
            <h2 className="text-lg font-semibold text-primary mb-1">
              {isLegalEntity ? '3' : '2'}. Wirtschaftlich Berechtigte
            </h2>
            <p className="text-sm text-muted mb-4">
              Personen mit mehr als 25 % Anteil oder vergleichbarer Kontrolle (§ 3 GwG).
            </p>

            {check.beneficialOwners.length > 0 && (
              <ul className="divide-y divide-border-subtle mb-4 border border-default rounded-md">
                {check.beneficialOwners.map((o) => (
                  <li key={o.id} className="px-4 py-3 flex items-center justify-between">
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
                      {(check.status === 'DRAFT' || check.status === 'IN_REVIEW') && (
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
                        />
                      )}
                    </div>
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
            <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
              <div>
                <h2 className="text-lg font-semibold text-primary mb-1">
                  {isLegalEntity ? '4' : '3'}. Identitätsdokumente
                </h2>
                <p className="text-sm text-muted">
                  Amtliche Ausweise der natürlichen beziehungsweise vertretungsberechtigten
                  Personen. Rechtsträgerunterlagen werden getrennt in Schritt 2 erfasst.
                </p>
              </div>
              {check.status !== 'VERIFIED' &&
                check.status !== 'REJECTED' &&
                check.status !== 'EXPIRED' && (
                  <DocumentUploadButton
                    clientId={client.id}
                    defaultClassification="GWG_EVIDENCE"
                    buttonLabel="Ausweiskopie hochladen"
                    buttonClassName="btn-secondary text-xs"
                  />
                )}
            </div>

            <GwgDocumentList documents={identityDocuments ?? []} />

            {check.status !== 'VERIFIED' &&
              check.status !== 'REJECTED' &&
              check.status !== 'EXPIRED' && (
                <AddIdDocumentForm
                  checkId={check.id}
                  clientId={client.id}
                  clientName={client.name}
                  clientDocuments={clientDocuments}
                  variant="identity"
                />
              )}
          </section>

          {/* Schritt 4: Verifikation oder Ablehnung */}
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
              />
            </section>
          )}
        </div>
      )}
    </div>
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

function GwgDocumentList({ documents }: { documents: DisplayGwgDocument[] }) {
  if (documents.length === 0) {
    return <p className="text-xs text-disabled mb-4">Noch kein Nachweis zugeordnet.</p>;
  }

  return (
    <ul className="divide-y divide-border-subtle mb-4 border border-default rounded-md">
      {documents.map((document) => (
        <li key={document.id} className="px-4 py-3">
          <div className="flex items-center gap-2 mb-1">
            <FileCheck className="h-4 w-4 text-green-600" />
            <span className="font-medium text-primary">
              {idTypeLabels[document.type] ?? document.type}
            </span>
            {document.expiryDate && document.expiryDate < new Date() && (
              <span className="badge-red">abgelaufen</span>
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
