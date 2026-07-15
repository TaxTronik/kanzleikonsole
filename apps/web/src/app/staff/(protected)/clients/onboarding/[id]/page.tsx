// =============================================================================
// /staff/clients/onboarding/[id] — Wizard-Schritte 2 bis n
//
// Schritt wird über ?step= gewählt. Bestimmte Schritte verlinken auf
// bestehende Seiten (Vollmacht, Anforderung), weil die dort vollständige
// Editoren haben — der Wizard tracked nur den Fortschritt.
// =============================================================================

import { redirect, notFound } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import {
  ArrowLeft,
  Wand2,
  ShieldCheck,
  ScrollText,
  Inbox,
  Check,
  ExternalLink,
} from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { canAccessClient } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { readModules } from '@/server/settings/modules';
import { Stepper } from '../stepper';
import { stepsForTenant, type StepKey } from '../steps';
import {
  onboardingAddContactAction,
  onboardingSendGwgAction,
  onboardingSkipAction,
  onboardingCompleteAction,
} from './actions';
import {
  GwgSubmissionSummary,
  type GwgSubmissionSummaryData,
} from '@/components/gwg-submission-summary';
import { QuickRequestDialog } from '@/components/quick-request-dialog';
import { readRequestCreationOptionsTx } from '@/server/request-creation-options';
import type {
  RequestFormTemplateOption,
  RequestTemplateOption,
} from '@/app/staff/(protected)/clients/[id]/requests/new/form';

interface Search {
  step?: string;
  error?: string;
}

const VALID_STEPS: StepKey[] = ['contact', 'gwg', 'poa', 'first_request', 'done'];

function parseStep(s: string | undefined): StepKey {
  if (s && (VALID_STEPS as string[]).includes(s)) return s as StepKey;
  return 'contact';
}

export default async function OnboardingStepPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Search>;
}) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  const { id } = await params;
  // Wizard liegt außerhalb von clients/[id]/ — der Layout-Guard greift hier
  // nicht, daher eigener Vertraulich-/RESTRICTED-Check.
  if (!(await canAccessClient(session, id))) redirect('/staff/clients?denied=1');
  const sp = await searchParams;
  const step = parseStep(sp.step);
  const { tenantId, staffId } = session.user;

  const [modules, data] = await Promise.all([
    readModules({ tenantId, actorId: staffId, actorType: 'STAFF' }),
    withTenantContext({ tenantId, actorId: staffId, actorType: 'STAFF' }, async (tx) => {
      const client = await tx.client.findUnique({
        where: { id },
        select: {
          id: true,
          name: true,
          kind: true,
          street: true,
          postalCode: true,
          city: true,
          countryIso: true,
          vatId: true,
          allowActive: true,
          onboardingCompletedAt: true,
        },
      });
      if (!client) return null;
      const [contactCount, gwgInvite, gwgCheck, poaCount, requestCount, requestCreationOptions] =
        await Promise.all([
          tx.clientContact.count({ where: { clientId: id, active: true } }),
          tx.gwgOnboardingInvite.findFirst({
            where: { clientId: id },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: {
              id: true,
              inviteEmail: true,
              inviteName: true,
              status: true,
              createdAt: true,
              expiresAt: true,
              submittedAt: true,
              uploadedDocumentIds: true,
            },
          }),
          tx.gwgCheck.findFirst({
            where: { clientId: id },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            include: {
              beneficialOwners: { orderBy: { createdAt: 'asc' } },
              idDocuments: { orderBy: { createdAt: 'asc' }, include: { document: true } },
            },
          }),
          tx.powerOfAttorney.count({ where: { clientId: id } }),
          tx.request.count({ where: { clientId: id } }),
          // Bei deaktiviertem Vollmachtsmodul wird `poa` weiter unten direkt
          // auf `first_request` abgebildet. Die Vorlagen müssen deshalb schon
          // für beide möglichen Roh-Schritte bereitstehen.
          step === 'first_request' || step === 'poa'
            ? readRequestCreationOptionsTx(tx)
            : Promise.resolve({
                requestTemplates: [],
                requestFormTemplates: [],
                templatesLimited: false,
                formTemplatesLimited: false,
              }),
        ]);
      const uploadedIds = Array.isArray(gwgInvite?.uploadedDocumentIds)
        ? (gwgInvite.uploadedDocumentIds as unknown[]).filter(
            (docId): docId is string => typeof docId === 'string',
          )
        : [];
      const uploadedDocuments =
        uploadedIds.length > 0
          ? await tx.document.findMany({
              where: { clientId: id, id: { in: uploadedIds } },
              select: { id: true, title: true, createdAt: true },
              orderBy: { createdAt: 'desc' },
            })
          : [];
      const firstContact = await tx.clientContact.findFirst({
        where: { clientId: id, active: true },
        orderBy: { createdAt: 'asc' },
        select: { fullName: true, email: true },
      });
      return {
        client,
        contactCount,
        gwgInvite,
        gwgCheck,
        poaCount,
        requestCount,
        requestCreationOptions,
        firstContact,
        uploadedDocuments,
      };
    }),
  ]);

  if (!data) notFound();
  const {
    client,
    contactCount,
    gwgInvite,
    gwgCheck,
    poaCount,
    requestCount,
    requestCreationOptions,
    firstContact,
    uploadedDocuments,
  } = data;
  const gwgSummary: GwgSubmissionSummaryData = {
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
    invite: gwgInvite
      ? {
          inviteName: gwgInvite.inviteName,
          inviteEmail: gwgInvite.inviteEmail,
          status: gwgInvite.status,
          createdAt: gwgInvite.createdAt.toISOString(),
          expiresAt: gwgInvite.expiresAt.toISOString(),
          submittedAt: gwgInvite.submittedAt?.toISOString() ?? null,
        }
      : null,
    owners:
      gwgCheck?.beneficialOwners.map((o) => ({
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
      gwgCheck?.idDocuments.map((d) => ({
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

  const steps = stepsForTenant(modules);
  const hasGwgSubmission = Boolean(
    gwgInvite?.submittedAt || gwgCheck || gwgSummary.uploadedDocuments.length > 0,
  );
  const doneKeys = new Set<StepKey>();
  doneKeys.add('master_data'); // sind wir hier, ist der Mandant da
  if (contactCount > 0) doneKeys.add('contact');
  if (gwgCheck?.status === 'VERIFIED') doneKeys.add('gwg');
  if (poaCount > 0) doneKeys.add('poa');
  if (requestCount > 0) doneKeys.add('first_request');
  if (client.onboardingCompletedAt) doneKeys.add('done');

  // Falls Modul deaktiviert: PoA-Schritt überspringen
  let activeStep: StepKey = client.onboardingCompletedAt && !sp.step ? 'done' : step;
  if (activeStep === 'poa' && modules.poaMode === 'OFF') {
    activeStep = 'first_request';
  }

  return (
    <div className="p-8 max-w-3xl">
      <Link href={`/staff/clients/${client.id}`} className="back-link">
        <ArrowLeft className="h-4 w-4" /> Zur Mandantenakte
      </Link>

      <div className="mb-6">
        <h1 className="page-title">
          <Wand2 className="h-6 w-6 text-brand-600" />
          Onboarding: {client.name}
        </h1>
        <p className="text-muted text-sm">Restliche Schritte zum vollständigen Erstkontakt.</p>
      </div>

      <Stepper steps={steps} currentKey={activeStep} doneKeys={doneKeys} />

      {activeStep === 'contact' && (
        <ContactStep
          clientId={client.id}
          contactName={firstContact?.fullName ?? ''}
          contactEmail={firstContact?.email ?? ''}
          allowActive={client.allowActive}
          error={sp.error}
        />
      )}

      {activeStep === 'gwg' && (
        <div className="space-y-4">
          <GwgStep
            clientId={client.id}
            defaultName={firstContact?.fullName ?? ''}
            defaultEmail={firstContact?.email ?? ''}
            existingInvite={gwgInvite}
            hasSubmission={hasGwgSubmission}
          />
          {(gwgInvite || gwgCheck || gwgSummary.uploadedDocuments.length > 0) && (
            <GwgSubmissionSummary data={gwgSummary} title="Aktueller Stand der GwG-Einreichung" />
          )}
        </div>
      )}

      {activeStep === 'poa' && modules.poaMode !== 'OFF' && (
        <PoaStep clientId={client.id} poaCount={poaCount} nextStep="first_request" />
      )}

      {activeStep === 'first_request' && (
        <FirstRequestStep
          client={client}
          requestCount={requestCount}
          templates={requestCreationOptions.requestTemplates}
          formTemplates={requestCreationOptions.requestFormTemplates}
          templatesLimited={requestCreationOptions.templatesLimited}
          formTemplatesLimited={requestCreationOptions.formTemplatesLimited}
        />
      )}

      {activeStep === 'done' && (
        <DoneStep
          clientId={client.id}
          summary={{
            contactCount,
            hasGwgInvite: Boolean(gwgInvite),
            poaCount,
            requestCount,
            allowActive: client.allowActive,
            onboardingCompletedAt: client.onboardingCompletedAt,
          }}
        />
      )}
    </div>
  );
}

// ----- Step Components --------------------------------------------------------

function ContactStep({
  clientId,
  contactName,
  contactEmail,
  allowActive,
  error,
}: {
  clientId: string;
  contactName: string;
  contactEmail: string;
  allowActive: boolean;
  error?: string;
}) {
  return (
    <div className="card p-6">
      <h2 className="text-sm font-medium text-primary mb-1">Ansprechpartner + Portal-Zugang</h2>
      <p className="text-xs text-muted mb-4">
        Mindestens ein Ansprechpartner ermöglicht später Portal-Login, Anforderungen und
        Magic-Link-Mails.
      </p>
      <form action={onboardingAddContactAction} className="space-y-4">
        {error && <div className="alert-error-sm">{error}</div>}
        <input type="hidden" name="clientId" value={clientId} />
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="fullName">
              Name <span className="text-red-600">*</span>
            </label>
            <input
              id="fullName"
              name="fullName"
              type="text"
              required
              maxLength={200}
              defaultValue={contactName}
              className="input"
            />
          </div>
          <div>
            <label className="label" htmlFor="email">
              E-Mail <span className="text-red-600">*</span>
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              maxLength={255}
              defaultValue={contactEmail}
              className="input"
            />
          </div>
          <div>
            <label className="label" htmlFor="phone">
              Telefon
            </label>
            <input id="phone" name="phone" type="tel" maxLength={50} className="input" />
          </div>
          <div>
            <label className="label" htmlFor="role">
              Rolle
            </label>
            <input
              id="role"
              name="role"
              type="text"
              maxLength={80}
              className="input"
              placeholder='z. B. „Geschäftsführer"'
            />
          </div>
        </div>
        <label
          className={
            allowActive
              ? 'flex items-center gap-2 text-sm'
              : 'flex items-start gap-2 text-sm text-muted'
          }
        >
          <input
            type="checkbox"
            name="sendPortalInvite"
            defaultChecked={allowActive}
            disabled={!allowActive}
            className="h-4 w-4 rounded border-strong text-brand-600 disabled:opacity-40 mt-0.5"
          />
          <span>
            Magic-Link für Portal-Zugang jetzt versenden
            {!allowActive && (
              <span className="block text-xs text-muted mt-0.5">
                Erst nach abgeschlossener GwG-Verifikation möglich. Im nächsten Schritt wird der
                GwG-Onboarding-Link versendet.
              </span>
            )}
          </span>
        </label>
        <div className="flex justify-end gap-2 pt-3 border-t border-subtle">
          <SkipButton clientId={clientId} next="gwg" label="Überspringen" />
          <button type="submit" className="btn-primary text-sm">
            Anlegen &amp; weiter
          </button>
        </div>
      </form>
    </div>
  );
}

function GwgStep({
  clientId,
  defaultName,
  defaultEmail,
  existingInvite,
  hasSubmission,
}: {
  clientId: string;
  defaultName: string;
  defaultEmail: string;
  existingInvite: { id: string; inviteEmail: string; inviteName: string; status: string } | null;
  hasSubmission: boolean;
}) {
  const sendFormId = `gwg-send-${clientId}`;
  return (
    <div className="card p-6">
      <h2 className="text-sm font-medium text-primary mb-1 flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-brand-600" />
        GwG-Onboarding starten
      </h2>
      <p className="text-xs text-muted mb-4">
        Der Mandant erhält per Mail einen Link zum Self-Service-GwG-Formular. Erst nach
        verifizierter Identitätsprüfung wird der Mandant intern auf <em>aktiv</em> geschaltet.
      </p>

      {existingInvite && (
        <div className="mb-4 p-3 rounded-md bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 text-xs text-emerald-800 dark:text-emerald-200">
          GwG-Einladung bereits an {existingInvite.inviteEmail} verschickt (Status:{' '}
          {existingInvite.status}).
        </div>
      )}

      <form id={sendFormId} action={onboardingSendGwgAction} className="space-y-4">
        <input type="hidden" name="clientId" value={clientId} />
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="inviteName">
              Name des Mandanten <span className="text-red-600">*</span>
            </label>
            <input
              id="inviteName"
              name="inviteName"
              type="text"
              required
              maxLength={200}
              defaultValue={defaultName}
              className="input"
            />
          </div>
          <div>
            <label className="label" htmlFor="inviteEmail">
              E-Mail <span className="text-red-600">*</span>
            </label>
            <input
              id="inviteEmail"
              name="inviteEmail"
              type="email"
              required
              maxLength={255}
              defaultValue={defaultEmail}
              className="input"
            />
          </div>
        </div>
      </form>
      <div className="flex justify-end gap-2 pt-3 mt-4 border-t border-subtle">
        {hasSubmission ? (
          <>
            <SkipButton clientId={clientId} next="poa" label="Später weiter" />
            <Link
              href={`/staff/clients/${clientId}/gwg?from=onboarding`}
              className="btn-primary text-sm"
            >
              Einreichung prüfen
            </Link>
          </>
        ) : existingInvite ? (
          <SkipButton clientId={clientId} next="poa" label="Weiter" />
        ) : null}
        <button
          type="submit"
          form={sendFormId}
          className={existingInvite ? 'btn-secondary text-sm' : 'btn-primary text-sm'}
        >
          {existingInvite ? 'Erneut senden' : 'Einladung senden'}
        </button>
      </div>
    </div>
  );
}

function PoaStep({
  clientId,
  poaCount,
  nextStep,
}: {
  clientId: string;
  poaCount: number;
  nextStep: string;
}) {
  return (
    <div className="card p-6">
      <h2 className="text-sm font-medium text-primary mb-1 flex items-center gap-2">
        <ScrollText className="h-4 w-4 text-brand-600" />
        Vollmacht erstellen
      </h2>
      <p className="text-xs text-muted mb-4">
        Optional. Die Vollmacht wird im Vollmachten-Modul angelegt und signiert — der Wizard wartet
        hier nicht auf eine Unterschrift.
      </p>
      {poaCount > 0 ? (
        <div className="mb-4 p-3 rounded-md bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 text-xs text-emerald-800 dark:text-emerald-200 inline-flex items-center gap-1">
          <Check className="h-3 w-3" /> {poaCount} Vollmacht{poaCount === 1 ? '' : 'en'} angelegt.
        </div>
      ) : null}
      <div className="flex justify-end gap-2 pt-3 border-t border-subtle">
        <SkipButton
          clientId={clientId}
          next={nextStep}
          label={poaCount > 0 ? 'Weiter' : 'Überspringen'}
        />
        <Link
          href={`/staff/poa/new?clientId=${clientId}&from=onboarding`}
          className="btn-primary text-sm inline-flex items-center gap-1"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Vollmacht anlegen
        </Link>
      </div>
    </div>
  );
}

function FirstRequestStep({
  client,
  requestCount,
  templates,
  formTemplates,
  templatesLimited,
  formTemplatesLimited,
}: {
  client: {
    id: string;
    name: string;
    allowActive: boolean;
  };
  requestCount: number;
  templates: RequestTemplateOption[];
  formTemplates: RequestFormTemplateOption[];
  templatesLimited: boolean;
  formTemplatesLimited: boolean;
}) {
  return (
    <div className="card p-6">
      <h2 className="text-sm font-medium text-primary mb-1 flex items-center gap-2">
        <Inbox className="h-4 w-4 text-brand-600" />
        Erste Anforderung
      </h2>
      <p className="text-xs text-muted mb-4">
        Z. B. Eröffnungsbilanz-Belege, Verträge oder Zugangsdaten. Anforderung erscheint im Portal
        des Mandanten.
      </p>
      {requestCount > 0 ? (
        <div className="mb-4 p-3 rounded-md bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 text-xs text-emerald-800 dark:text-emerald-200 inline-flex items-center gap-1">
          <Check className="h-3 w-3" /> {requestCount} Anforderung{requestCount === 1 ? '' : 'en'}{' '}
          angelegt.
        </div>
      ) : null}
      <div className="flex justify-end gap-2 pt-3 border-t border-subtle">
        <SkipButton
          clientId={client.id}
          next="done"
          label={requestCount > 0 ? 'Weiter' : 'Überspringen'}
        />
        <QuickRequestDialog
          requestId={randomUUID()}
          client={{
            id: client.id,
            name: client.name,
            datevNo: null,
            addisonNo: null,
            allowActive: client.allowActive,
          }}
          templates={templates}
          formTemplates={formTemplates}
          templatesLimited={templatesLimited}
          formTemplatesLimited={formTemplatesLimited}
          buttonLabel="Anforderung anlegen"
          buttonClassName="btn-primary text-sm"
        />
      </div>
    </div>
  );
}

function DoneStep({
  clientId,
  summary,
}: {
  clientId: string;
  summary: {
    contactCount: number;
    hasGwgInvite: boolean;
    poaCount: number;
    requestCount: number;
    allowActive: boolean;
    onboardingCompletedAt: Date | null;
  };
}) {
  return (
    <div className="card p-6">
      <h2 className="text-sm font-medium text-primary mb-1 flex items-center gap-2">
        <Check className="h-4 w-4 text-emerald-600" />
        Onboarding abschließen
      </h2>
      <p className="text-xs text-muted mb-4">
        Übersicht der angelegten Daten. Du kannst jederzeit zurück zu einem Schritt navigieren.
      </p>

      <ul className="text-sm space-y-2 mb-6">
        <li className="flex items-center justify-between">
          <span>Ansprechpartner</span>
          <span className="text-secondary">{summary.contactCount}</span>
        </li>
        <li className="flex items-center justify-between">
          <span>Onboarding-Abschluss</span>
          <span className="text-secondary">
            {summary.onboardingCompletedAt ? 'Bereits abgeschlossen' : 'Noch zu bestätigen'}
          </span>
        </li>
        <li className="flex items-center justify-between">
          <span>GwG-Einladung versendet</span>
          <span className="text-secondary">{summary.hasGwgInvite ? 'Ja' : 'Nein'}</span>
        </li>
        <li className="flex items-center justify-between">
          <span>Vollmachten angelegt</span>
          <span className="text-secondary">{summary.poaCount}</span>
        </li>
        <li className="flex items-center justify-between">
          <span>Anforderungen angelegt</span>
          <span className="text-secondary">{summary.requestCount}</span>
        </li>
        <li className="flex items-center justify-between">
          <span>Mandant intern aktiv</span>
          <span className="text-secondary">
            {summary.allowActive ? 'Ja' : 'Nein (wartet auf GwG-Verifikation)'}
          </span>
        </li>
      </ul>

      {!summary.onboardingCompletedAt && !summary.allowActive && (
        <p className="text-xs text-amber-700 mb-4">
          Die GwG-Prüfung ist noch nicht durch den verantwortlichen Berufsträger freigegeben. Eine
          Einladung allein schließt diesen Pflichtschritt nicht ab.
        </p>
      )}

      {summary.onboardingCompletedAt ? (
        <div className="flex items-center justify-between gap-3 pt-3 border-t border-subtle">
          <p className="text-xs text-emerald-700">
            Das Erst-Onboarding ist historisch und auditierbar abgeschlossen.
          </p>
          <Link href={`/staff/clients/${clientId}`} className="btn-primary text-sm">
            Zur Mandantenakte
          </Link>
        </div>
      ) : summary.contactCount === 0 ? (
        <div className="flex items-center justify-between gap-3 pt-3 border-t border-subtle">
          <p className="text-xs text-amber-700">
            Zum Abschluss wird mindestens ein aktiver Ansprechpartner benötigt.
          </p>
          <Link
            href={`/staff/clients/onboarding/${clientId}?step=contact`}
            className="btn-primary text-sm"
          >
            Ansprechpartner erfassen
          </Link>
        </div>
      ) : summary.allowActive ? (
        <form action={onboardingCompleteAction}>
          <input type="hidden" name="clientId" value={clientId} />
          <div className="flex justify-end pt-3 border-t border-subtle">
            <button type="submit" className="btn-primary text-sm">
              Onboarding abschließen &amp; zur Mandantenakte
            </button>
          </div>
        </form>
      ) : (
        <div className="flex items-center justify-between gap-3 pt-3 border-t border-subtle">
          <p className="text-xs text-amber-700">
            Erst nach Freigabe der GwG-Prüfung kann das Onboarding abgeschlossen werden.
          </p>
          <Link
            href={`/staff/clients/${clientId}/gwg?from=onboarding`}
            className="btn-primary text-sm"
          >
            GwG-Prüfung öffnen
          </Link>
        </div>
      )}
    </div>
  );
}

function SkipButton({ clientId, next, label }: { clientId: string; next: string; label: string }) {
  return (
    <form action={onboardingSkipAction} className="inline">
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="next" value={next} />
      <button type="submit" className="btn-secondary text-sm">
        {label}
      </button>
    </form>
  );
}
