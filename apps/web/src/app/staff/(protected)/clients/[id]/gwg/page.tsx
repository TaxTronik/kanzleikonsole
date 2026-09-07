import { requireStaffPage } from '@/server/auth/staff-page';
import { GwgStructurePanel } from '@/server/mandate-expansion/gwg-structure-panel';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import { Stepper } from '@/components/stepper';
import { GwgIdentitySubjectsProvider } from './identity-subjects-context';
import { GwgEditStateProvider, GwgLiveStatusBadge } from './edit-state-context';
import { StartCheckCycleForm } from './start-check-cycle-form';
import { loadGwgPageData } from './gwg-page-data';
import { buildGwgPageModel } from './gwg-page-model';
import { GwgCheckHistory, GwgMasterData } from './gwg-page-overview';
import { GwgCheckStatus } from './gwg-page-status';
import { GwgInvitation } from './gwg-page-invitation';
import { GwgPersons } from './gwg-page-persons';
import { GwgEntityEvidence } from './gwg-page-evidence';
import { GwgAssessment } from './gwg-page-assessment';

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
  const data = await loadGwgPageData({
    clientId,
    tenantId: session.user.tenantId,
    staffId: session.user.staffId,
  });
  if (!data) notFound();
  const { client, check, checkHistory, contacts, canVerify } = data;
  const model = buildGwgPageModel(data);
  const { subjectOptions, gwgSteps, isLegalEntity, destroyed, expired } = model;
  const backLink = gwgBackLink(client.id, from);
  return (
    <GwgEditStateProvider initialStatus={check?.status ?? 'DRAFT'}>
      <GwgIdentitySubjectsProvider initialOptions={subjectOptions}>
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
                {check &&
                  (destroyed || expired ? (
                    <span className="badge badge-red">{model.displayStatus}</span>
                  ) : (
                    <GwgLiveStatusBadge />
                  ))}
              </div>
              <p className="text-muted text-sm">{client.name}</p>
            </div>
          </div>

          {checkHistory.length > 0 && <GwgCheckHistory checkHistory={checkHistory} />}
          {isLegalEntity && !destroyed && <GwgMasterData client={client} check={check} />}
          <GwgStructurePanel session={session} clientId={clientId} />
          {!destroyed && (
            <>
              {check && (
                <div className="card mb-6">
                  <div className="p-5">
                    <Stepper steps={gwgSteps} />
                  </div>
                </div>
              )}
              <GwgInvitation model={model} data={data} />
              <GwgPersons model={model} canVerify={canVerify} />
            </>
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
              <GwgCheckStatus
                clientId={client.id}
                check={check}
                from={from}
                contacts={contacts}
                availability={model}
              />
              {!destroyed && (
                <>
                  {check.status === 'IN_REVIEW' && canVerify && (
                    <div className="rounded-md border border-blue-300 bg-blue-50 p-4 text-sm text-blue-900 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-100">
                      <p className="font-semibold">Berufsträger-Prüfmodus</p>
                      <p className="mt-1 text-xs">
                        Prüfen Sie jetzt den vollständigen Snapshot von Risikobewertung,
                        Rechtsträger, wirtschaftlich Berechtigten, Vertretung und Nachweisen.
                        Ausweise sind für diese Schlussprüfung aufgeklappt; die Entscheidung am
                        Seitenende wird exakt an diesen Datenstand gebunden und protokolliert.
                      </p>
                    </div>
                  )}

                  {isLegalEntity && <GwgEntityEvidence model={model} />}
                  <GwgAssessment model={model} canVerify={canVerify} />
                </>
              )}
            </div>
          )}
        </div>
      </GwgIdentitySubjectsProvider>
    </GwgEditStateProvider>
  );
}
function gwgBackLink(clientId: string, from?: string) {
  return from === 'onboarding'
    ? { href: `/staff/clients/onboarding/${clientId}?step=gwg`, label: 'Zurück zum Onboarding' }
    : { href: `/staff/clients/${clientId}`, label: 'Zurück zum Mandanten' };
}
