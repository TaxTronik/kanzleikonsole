import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, ShieldCheck, AlertTriangle, FileCheck } from 'lucide-react';
import { DEFAULT_FACTORS } from '@/server/gwg/risk-score';
import { openCheckAction } from './actions';
import { RiskAssessmentForm } from './risk-assessment-form';
import { AddBeneficialOwnerForm } from './add-owner-form';
import { AddIdDocumentForm } from './add-id-doc-form';
import { InviteSection } from './invite-section';
import { GwgDecisionForms } from './decision-forms';
import { fmtDateShort } from '@/lib/fmt';
import { DocumentPreviewButton } from '@/components/document-preview';
import { GwgSubmissionSummary, type GwgSubmissionSummaryData } from '@/components/gwg-submission-summary';

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

export default async function GwgPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');

  const { id: clientId } = await params;
  const { tenantId, staffId } = session.user;

  const data = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const client = await tx.client.findUnique({ where: { id: clientId } });
      if (!client) return null;
      const [check, clientDocuments, invites, contacts] = await Promise.all([
        tx.gwgCheck.findFirst({
          where: { clientId },
          orderBy: { createdAt: 'desc' },
          include: {
            beneficialOwners: { orderBy: { createdAt: 'asc' } },
            idDocuments: { orderBy: { createdAt: 'asc' }, include: { document: true } },
          },
        }),
        tx.document.findMany({
          where: { clientId },
          select: { id: true, title: true },
          orderBy: { createdAt: 'desc' },
        }),
        tx.gwgOnboardingInvite.findMany({
          where: { clientId },
          orderBy: { createdAt: 'desc' },
          take: 10,
        }),
        tx.clientContact.findMany({
          where: { clientId, active: true },
          select: { fullName: true, email: true },
          orderBy: { fullName: 'asc' },
        }),
      ]);
      const latestInvite = invites[0] ?? null;
      const uploadedIds = Array.isArray(latestInvite?.uploadedDocumentIds)
        ? (latestInvite.uploadedDocumentIds as unknown[]).filter((id): id is string => typeof id === 'string')
        : [];
      const uploadedDocuments = uploadedIds.length > 0
        ? await tx.document.findMany({
            where: { clientId, id: { in: uploadedIds } },
            select: { id: true, title: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
          })
        : [];
      return { client, check, clientDocuments, invites, contacts, uploadedDocuments };
    },
  );

  if (!data) notFound();
  const { client, check, clientDocuments, invites, contacts, uploadedDocuments } = data;
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
    owners: check?.beneficialOwners.map((o) => ({
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
    idDocuments: check?.idDocuments.map((d) => ({
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
        <Link href={`/staff/clients/${client.id}`} className="text-disabled hover:text-secondary mt-1">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold text-primary">GwG-Prüfung</h1>
            {check && (
              <span className={
                check.status === 'VERIFIED' ? 'badge-green'
                : check.status === 'REJECTED' || check.status === 'EXPIRED' ? 'badge-red'
                : 'badge-yellow'
              }>
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
          <h2 className="text-lg font-semibold text-primary mb-2">
            Noch keine GwG-Prüfung
          </h2>
          <p className="text-sm text-muted mb-6">
            Sie können die Prüfung selbst starten — oder den Mandanten oben per Einladung
            einladen, die Stammdaten und Ausweise selbst hochzuladen.
          </p>
          <form action={openCheckAction}>
            <input type="hidden" name="clientId" value={client.id} />
            <button type="submit" className="btn-primary">
              Prüfung manuell starten
            </button>
          </form>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Status-Banner */}
          {check.status === 'VERIFIED' && check.validUntil && (
            <div className="rounded-md bg-green-50 p-4 border border-green-200">
              <div className="flex items-start gap-3">
                <ShieldCheck className="h-5 w-5 text-green-600 mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-green-900">
                    Mandant ist verifiziert.
                  </p>
                  <p className="text-xs text-green-700 mt-1">
                    Risiko: <strong>{check.riskLevel}</strong> ·
                    Gültig bis {fmtDateShort(check.validUntil)}
                  </p>
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

          {/* Schritt 1: Risikobewertung */}
          <section className="card p-6">
            <h2 className="text-lg font-semibold text-primary mb-1">
              1. Risikobewertung
            </h2>
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
              disabled={check.status === 'VERIFIED' || check.status === 'REJECTED'}
            />
          </section>

          {/* Schritt 2: Wirtschaftlich Berechtigte */}
          <section className="card p-6">
            <h2 className="text-lg font-semibold text-primary mb-1">
              2. Wirtschaftlich Berechtigte
            </h2>
            <p className="text-sm text-muted mb-4">
              Personen mit ≥ 25 % Anteil oder vergleichbarer Kontrolle (§ 3 GwG).
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
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {check.status !== 'VERIFIED' && check.status !== 'REJECTED' && (
              <AddBeneficialOwnerForm checkId={check.id} clientId={client.id} />
            )}
          </section>

          {/* Schritt 3: Identitätsdokumente */}
          <section className="card p-6">
            <h2 className="text-lg font-semibold text-primary mb-1">
              3. Identitätsdokumente
            </h2>
            <p className="text-sm text-muted mb-4">
              Personalausweise / Handelsregisterauszüge / Transparenzregister-Auszüge
              (laden Sie Dokumente erst hoch und ordnen Sie sie hier zu).
            </p>

            {check.idDocuments.length > 0 && (
              <ul className="divide-y divide-border-subtle mb-4 border border-default rounded-md">
                {check.idDocuments.map((d) => (
                  <li key={d.id} className="px-4 py-3">
                    <div className="flex items-center gap-2 mb-1">
                      <FileCheck className="h-4 w-4 text-green-600" />
                      <span className="font-medium text-primary">
                        {idTypeLabels[d.type] ?? d.type}
                      </span>
                      {d.expiryDate && d.expiryDate < new Date() && (
                        <span className="badge-red">abgelaufen</span>
                      )}
                    </div>
                    <p className="text-xs text-muted ml-6">
                      {d.ownerName}
                      {d.number ? ` · Nr. ${d.number}` : ''}
                      {d.expiryDate ? ` · gültig bis ${fmtDateShort(d.expiryDate)}` : ''}
                    </p>
                    {d.document && (
                      <div className="flex items-center gap-1 ml-6 mt-1">
                        <span className="text-xs text-muted">{d.document.title}</span>
                        <DocumentPreviewButton documentId={d.document.id} documentTitle={d.document.title} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {check.status !== 'VERIFIED' && check.status !== 'REJECTED' && (
              <AddIdDocumentForm
                checkId={check.id}
                clientId={client.id}
                clientDocuments={clientDocuments}
              />
            )}
          </section>

          {/* Schritt 4: Verifikation oder Ablehnung */}
          {check.status === 'IN_REVIEW' && (
            <section className="card p-6">
              <h2 className="text-lg font-semibold text-primary mb-3">
                4. Entscheidung
              </h2>
              <GwgDecisionForms checkId={check.id} clientId={client.id} />
            </section>
          )}
        </div>
      )}
    </div>
  );
}
