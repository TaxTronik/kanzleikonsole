// =============================================================================
// /staff/clients/onboarding/[id] — Wizard-Schritte 2 bis n
//
// Schritt wird über ?step= gewählt. Bestimmte Schritte verlinken auf
// bestehende Seiten (Vollmacht, Anforderung), weil die dort vollständige
// Editoren haben — der Wizard tracked nur den Fortschritt.
// =============================================================================

import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Wand2, ShieldCheck, ScrollText, Inbox, Check, ExternalLink } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
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

interface Search { step?: string; }

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
  const sp = await searchParams;
  const step = parseStep(sp.step);
  const { tenantId, staffId } = session.user;

  const [modules, data] = await Promise.all([
    readModules({ tenantId, actorId: staffId, actorType: 'STAFF' }),
    withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        const client = await tx.client.findUnique({
          where: { id },
          select: { id: true, name: true, kind: true, allowActive: true },
        });
        if (!client) return null;
        const [contactCount, gwgInvite, gwgCheck, poaCount, requestCount] = await Promise.all([
          tx.clientContact.count({ where: { clientId: id, active: true } }),
          tx.gwgOnboardingInvite.findFirst({
            where: { clientId: id },
            orderBy: { createdAt: 'desc' },
            select: { id: true, inviteEmail: true, inviteName: true, status: true },
          }),
          tx.gwgCheck.findFirst({
            where: { clientId: id },
            orderBy: { createdAt: 'desc' },
            select: { status: true },
          }),
          tx.powerOfAttorney.count({ where: { clientId: id } }),
          tx.request.count({ where: { clientId: id } }),
        ]);
        const firstContact = await tx.clientContact.findFirst({
          where: { clientId: id, active: true },
          orderBy: { createdAt: 'asc' },
          select: { fullName: true, email: true },
        });
        return { client, contactCount, gwgInvite, gwgCheck, poaCount, requestCount, firstContact };
      },
    ),
  ]);

  if (!data) notFound();
  const { client, contactCount, gwgInvite, gwgCheck, poaCount, requestCount, firstContact } = data;

  const steps = stepsForTenant(modules);
  const doneKeys = new Set<StepKey>();
  doneKeys.add('master_data'); // sind wir hier, ist der Mandant da
  if (contactCount > 0) doneKeys.add('contact');
  if (gwgInvite || (gwgCheck && gwgCheck.status === 'VERIFIED')) doneKeys.add('gwg');
  if (poaCount > 0) doneKeys.add('poa');
  if (requestCount > 0) doneKeys.add('first_request');

  // Falls Modul deaktiviert: PoA-Schritt überspringen
  let activeStep = step;
  if (activeStep === 'poa' && modules.poaMode === 'OFF') {
    activeStep = 'first_request';
  }

  return (
    <div className="p-8 max-w-3xl">
      <Link
        href={`/staff/clients/${client.id}`}
        className="back-link"
      >
        <ArrowLeft className="h-4 w-4" /> Zur Mandantenakte
      </Link>

      <div className="mb-6">
        <h1 className="page-title">
          <Wand2 className="h-6 w-6 text-brand-600" />
          Onboarding: {client.name}
        </h1>
        <p className="text-muted text-sm">
          Restliche Schritte zum vollständigen Erstkontakt.
        </p>
      </div>

      <Stepper steps={steps} currentKey={activeStep} doneKeys={doneKeys} />

      {activeStep === 'contact' && (
        <ContactStep clientId={client.id} contactName={firstContact?.fullName ?? ''} contactEmail={firstContact?.email ?? ''} />
      )}

      {activeStep === 'gwg' && (
        <GwgStep
          clientId={client.id}
          defaultName={firstContact?.fullName ?? ''}
          defaultEmail={firstContact?.email ?? ''}
          existingInvite={gwgInvite}
        />
      )}

      {activeStep === 'poa' && modules.poaMode !== 'OFF' && (
        <PoaStep clientId={client.id} poaCount={poaCount} nextStep="first_request" />
      )}

      {activeStep === 'first_request' && (
        <FirstRequestStep clientId={client.id} requestCount={requestCount} />
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
          }}
        />
      )}
    </div>
  );
}

// ----- Step Components --------------------------------------------------------

function ContactStep({ clientId, contactName, contactEmail }: { clientId: string; contactName: string; contactEmail: string }) {
  return (
    <div className="card p-6">
      <h2 className="text-sm font-medium text-primary mb-1">Ansprechpartner + Portal-Zugang</h2>
      <p className="text-xs text-muted mb-4">
        Mindestens ein Ansprechpartner ermöglicht später Portal-Login, Anforderungen und Magic-Link-Mails.
      </p>
      <form action={onboardingAddContactAction} className="space-y-4">
        <input type="hidden" name="clientId" value={clientId} />
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="fullName">Name <span className="text-red-600">*</span></label>
            <input id="fullName" name="fullName" type="text" required maxLength={200} defaultValue={contactName} className="input" />
          </div>
          <div>
            <label className="label" htmlFor="email">E-Mail <span className="text-red-600">*</span></label>
            <input id="email" name="email" type="email" required maxLength={255} defaultValue={contactEmail} className="input" />
          </div>
          <div>
            <label className="label" htmlFor="phone">Telefon</label>
            <input id="phone" name="phone" type="tel" maxLength={50} className="input" />
          </div>
          <div>
            <label className="label" htmlFor="role">Rolle</label>
            <input id="role" name="role" type="text" maxLength={80} className="input" placeholder='z. B. „Geschäftsführer"' />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="sendPortalInvite" defaultChecked className="h-4 w-4 rounded border-strong text-brand-600" />
          Magic-Link für Portal-Zugang jetzt versenden
        </label>
        <div className="flex justify-end gap-2 pt-3 border-t border-subtle">
          <SkipButton clientId={clientId} next="gwg" label="Überspringen" />
          <button type="submit" className="btn-primary text-sm">Anlegen &amp; weiter</button>
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
}: {
  clientId: string;
  defaultName: string;
  defaultEmail: string;
  existingInvite: { id: string; inviteEmail: string; inviteName: string; status: string } | null;
}) {
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
          GwG-Einladung bereits am {existingInvite.inviteEmail} verschickt (Status: {existingInvite.status}).
        </div>
      )}

      <form action={onboardingSendGwgAction} className="space-y-4">
        <input type="hidden" name="clientId" value={clientId} />
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="inviteName">Name des Mandanten <span className="text-red-600">*</span></label>
            <input id="inviteName" name="inviteName" type="text" required maxLength={200} defaultValue={defaultName} className="input" />
          </div>
          <div>
            <label className="label" htmlFor="inviteEmail">E-Mail <span className="text-red-600">*</span></label>
            <input id="inviteEmail" name="inviteEmail" type="email" required maxLength={255} defaultValue={defaultEmail} className="input" />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-3 border-t border-subtle">
          {existingInvite && (
            <SkipButton clientId={clientId} next="poa" label="Bereits gesendet — weiter" />
          )}
          <button type="submit" className="btn-primary text-sm">
            {existingInvite ? 'Erneut senden' : 'Einladung senden'}
          </button>
        </div>
      </form>
    </div>
  );
}

function PoaStep({ clientId, poaCount, nextStep }: { clientId: string; poaCount: number; nextStep: string }) {
  return (
    <div className="card p-6">
      <h2 className="text-sm font-medium text-primary mb-1 flex items-center gap-2">
        <ScrollText className="h-4 w-4 text-brand-600" />
        Vollmacht erstellen
      </h2>
      <p className="text-xs text-muted mb-4">
        Optional. Die Vollmacht wird im Vollmachten-Modul angelegt und signiert — der Wizard
        wartet hier nicht auf eine Unterschrift.
      </p>
      {poaCount > 0 ? (
        <div className="mb-4 p-3 rounded-md bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 text-xs text-emerald-800 dark:text-emerald-200 inline-flex items-center gap-1">
          <Check className="h-3 w-3" /> {poaCount} Vollmacht{poaCount === 1 ? '' : 'en'} angelegt.
        </div>
      ) : null}
      <div className="flex justify-end gap-2 pt-3 border-t border-subtle">
        <SkipButton clientId={clientId} next={nextStep} label={poaCount > 0 ? 'Weiter' : 'Überspringen'} />
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

function FirstRequestStep({ clientId, requestCount }: { clientId: string; requestCount: number }) {
  return (
    <div className="card p-6">
      <h2 className="text-sm font-medium text-primary mb-1 flex items-center gap-2">
        <Inbox className="h-4 w-4 text-brand-600" />
        Erste Anforderung
      </h2>
      <p className="text-xs text-muted mb-4">
        Z. B. Eröffnungsbilanz-Belege, Verträge oder Zugangsdaten. Anforderung erscheint
        im Portal des Mandanten.
      </p>
      {requestCount > 0 ? (
        <div className="mb-4 p-3 rounded-md bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 text-xs text-emerald-800 dark:text-emerald-200 inline-flex items-center gap-1">
          <Check className="h-3 w-3" /> {requestCount} Anforderung{requestCount === 1 ? '' : 'en'} angelegt.
        </div>
      ) : null}
      <div className="flex justify-end gap-2 pt-3 border-t border-subtle">
        <SkipButton clientId={clientId} next="done" label={requestCount > 0 ? 'Weiter' : 'Überspringen'} />
        <Link
          href={`/staff/clients/${clientId}/requests/new?from=onboarding`}
          className="btn-primary text-sm inline-flex items-center gap-1"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Anforderung anlegen
        </Link>
      </div>
    </div>
  );
}

function DoneStep({
  clientId,
  summary,
}: {
  clientId: string;
  summary: { contactCount: number; hasGwgInvite: boolean; poaCount: number; requestCount: number; allowActive: boolean };
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

      {!summary.hasGwgInvite && (
        <p className="text-xs text-amber-700 mb-4">
          ⚠ Pflichtschritt „GwG-Onboarding" ist noch nicht abgeschlossen.
          Der Mandant kann erst nach GwG-Verifikation aktiv geschaltet werden.
        </p>
      )}

      <form action={onboardingCompleteAction}>
        <input type="hidden" name="clientId" value={clientId} />
        <div className="flex justify-end pt-3 border-t border-subtle">
          <button type="submit" className="btn-primary text-sm">
            Onboarding abschließen &amp; zur Mandantenakte
          </button>
        </div>
      </form>
    </div>
  );
}

function SkipButton({ clientId, next, label }: { clientId: string; next: string; label: string }) {
  return (
    <form action={onboardingSkipAction} className="inline">
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="next" value={next} />
      <button type="submit" className="btn-secondary text-sm">{label}</button>
    </form>
  );
}
