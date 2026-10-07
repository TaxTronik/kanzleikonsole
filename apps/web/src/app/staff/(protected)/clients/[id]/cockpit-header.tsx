// =============================================================================
// Kopf des Mandanten-Cockpits (Review-Befund K-04): Titel mit Aktionen,
// Onboarding-Hinweis und Reiterleiste. Alles rendert sofort aus den Kopfdaten
// (loadClientCockpitHeader); nur die Subsumtions-Pill streamt, weil sie auf
// den Healthcheck der Signal-Engine wartet.
// =============================================================================

import { Suspense } from 'react';
import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { ArrowLeft, Wand2 } from 'lucide-react';
import { isElsterConfigured } from '@taxtronik/elster';
import { computeOnboardingStatus, resumeStep } from '@/server/onboarding/status';
import { isRiskLayerAvailable } from '@/server/risk/availability';
import type { resolveClientNavigation } from '@/lib/navigation-registry';
import { QuickRequestDialog } from '@/components/quick-request-dialog';
import { createQuickRequestAction } from '@/app/staff/(protected)/clients/[id]/requests/actions';
import { CLIENT_KIND_LABELS, domainLabel } from '@/lib/domain-labels';
import type { ClientCockpitClient, ClientCockpitHeaderData } from './_data';

type Responsibilities = ClientCockpitClient['responsibilities'];

/**
 * Subsumtion/TCMS: Admin/Partner ODER dem Mandanten zugeordneter
 * Berufsträger/Hauptbearbeiter (das Modul prüft die Reiterleiste zusätzlich).
 */
export function canOpenSubsumtion(
  isAdmin: boolean,
  staffId: string,
  responsibilities: Responsibilities,
): boolean {
  return (
    isAdmin ||
    responsibilities.some(
      (r) => r.staff.id === staffId && (r.role === 'BERUFSTRAEGER' || r.role === 'HAUPTBEARBEITER'),
    )
  );
}

export function ClientCockpitHeader({ header }: { header: ClientCockpitHeaderData }) {
  const { client, requestTemplates, requestFormTemplates, templatesLimited, formTemplatesLimited } =
    header;
  return (
    <div className="flex items-start gap-4 mb-8">
      <Link
        href="/staff/clients"
        aria-label="Zurück"
        className="text-disabled hover:text-secondary mt-1"
      >
        <ArrowLeft className="h-5 w-5" />
      </Link>
      <div className="flex-1">
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-2xl font-bold text-primary">{client.name}</h1>
          {client.allowActive ? (
            <span className="badge-green">Aktiv</span>
          ) : (
            <span className="badge-yellow">GwG ausstehend</span>
          )}
        </div>
        <ClientAccountingLabels
          kind={client.kind}
          datevNo={client.datevNo}
          addisonNo={client.addisonNo}
        />
        <ClientResponsibilities responsibilities={client.responsibilities} />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <QuickRequestDialog
          createAction={createQuickRequestAction}
          requestId={randomUUID()}
          client={{
            id: client.id,
            name: client.name,
            datevNo: client.datevNo,
            addisonNo: client.addisonNo,
            allowActive: client.allowActive,
          }}
          templates={requestTemplates}
          formTemplates={requestFormTemplates}
          templatesLimited={templatesLimited}
          formTemplatesLimited={formTemplatesLimited}
          buttonClassName="btn-secondary text-xs py-1.5"
        />
        <Link href={`/staff/clients/${client.id}/edit`} className="btn-primary text-xs py-1.5">
          Stammdaten bearbeiten
        </Link>
      </div>
    </div>
  );
}

function ClientAccountingLabels({
  kind,
  datevNo,
  addisonNo,
}: {
  kind: string;
  datevNo: string | null;
  addisonNo: string | null;
}) {
  return (
    <p className="text-muted text-sm">
      {domainLabel(CLIENT_KIND_LABELS, kind)}
      {datevNo ? ` · DATEV ${datevNo}` : ''}
      {addisonNo ? ` · Addison ${addisonNo}` : ''}
    </p>
  );
}

function ClientResponsibilities({ responsibilities }: { responsibilities: Responsibilities }) {
  const berufstraeger = responsibilities.filter((r) => r.role === 'BERUFSTRAEGER');
  const bearbeiter = responsibilities.filter((r) => r.role === 'HAUPTBEARBEITER');
  if (berufstraeger.length === 0 && bearbeiter.length === 0) return null;
  return (
    <div className="text-xs text-muted mt-1 space-y-0.5">
      {berufstraeger.length > 0 && (
        <p>
          <span className="font-medium text-secondary">Berufsträger:</span>{' '}
          {berufstraeger.map((r) => r.staff.fullName).join(', ')}
        </p>
      )}
      {bearbeiter.length > 0 && (
        <p>
          <span className="font-medium text-secondary">Bearbeiter:</span>{' '}
          {bearbeiter.map((r) => r.staff.fullName).join(', ')}
        </p>
      )}
    </div>
  );
}

export function ClientOnboardingBanner({ client }: { client: ClientCockpitClient }) {
  const onboardingInput = {
    allowActive: client.allowActive,
    onboardingCompletedAt: client.onboardingCompletedAt,
    contactsActive: client.contacts.length,
    gwgChecks: client._count.gwgChecks,
    gwgInvites: client._count.gwgInvites,
    poas: client._count.poas,
    requests: client._count.requests,
  };
  const ob = computeOnboardingStatus(onboardingInput);
  if (ob === 'COMPLETE') return null;
  const next = resumeStep(onboardingInput);
  return (
    <div className="mb-4 -mt-3 flex items-center justify-between gap-3 rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-4 py-2 text-sm">
      <span className="text-amber-900 dark:text-amber-100 inline-flex items-center gap-2">
        <Wand2 className="h-4 w-4" />
        Onboarding {ob === 'IN_PROGRESS' ? 'läuft noch' : 'noch nicht gestartet'}.
      </span>
      <Link
        href={`/staff/clients/onboarding/${client.id}?step=${next}`}
        className="btn-primary text-xs py-1 inline-flex items-center gap-1"
      >
        {ob === 'IN_PROGRESS' ? 'Fortsetzen' : 'Starten'} →
      </Link>
    </div>
  );
}

/**
 * Navigation als horizontale Pill-Leiste — spart vertikalen Platz.
 * Modulabhängige Reiter kommen aus der Modul-Registry (wie Route-Gate und
 * Seiten-Gate der Zielseiten).
 */
export function ClientCockpitNav({
  client,
  clientNav,
  pendingChangeRequests,
  canSubsumtion,
}: {
  client: Pick<ClientCockpitClient, 'id' | '_count'>;
  clientNav: ReturnType<typeof resolveClientNavigation>;
  pendingChangeRequests: number;
  canSubsumtion: boolean;
}) {
  return (
    <nav className="flex flex-wrap gap-2 mb-6">
      <Link href={`/staff/clients/${client.id}/timeline`} className="btn-secondary text-xs py-1">
        Aktivitätsstrom
      </Link>
      {clientNav.billing && (
        <Link href={clientNav.billing} className="btn-secondary text-xs py-1">
          Stunden abrechnen
        </Link>
      )}
      {clientNav.bwa && (
        <Link href={clientNav.bwa} className="btn-secondary text-xs py-1">
          BWA & Auswertungen
        </Link>
      )}
      <Link href={`/staff/clients/${client.id}/gwg`} className="btn-secondary text-xs py-1">
        GwG-Prüfung
      </Link>
      <Link href={`/staff/clients/${client.id}/privacy`} className="btn-secondary text-xs py-1">
        Datenschutz
      </Link>
      {clientNav.poa && (
        <Link href={clientNav.poa} className="btn-secondary text-xs py-1">
          Vollmachten
          {client._count.poas > 0 && <span className="badge-gray ml-2">{client._count.poas}</span>}
        </Link>
      )}
      {clientNav.subsumtion && canSubsumtion && (
        // Der Engine-Healthcheck (HTTP) hält nur diese Pill auf, nicht die Seite.
        <Suspense fallback={null}>
          <SubsumtionNavLink clientId={client.id} />
        </Suspense>
      )}
      {clientNav['tax-schedule'] && (
        <Link href={clientNav['tax-schedule']} className="btn-secondary text-xs py-1">
          Steuertermine
        </Link>
      )}
      {clientNav.notices && (
        <Link href={clientNav.notices} className="btn-secondary text-xs py-1">
          Bescheide
        </Link>
      )}
      {isElsterConfigured() && (
        <Link href={`/staff/clients/${client.id}/elster`} className="btn-secondary text-xs py-1">
          Steuerkonto (ELSTER)
        </Link>
      )}
      {clientNav.workflows && (
        <Link href={clientNav.workflows} className="btn-secondary text-xs py-1">
          Workflows
        </Link>
      )}
      {clientNav.forms && (
        <Link href={clientNav.forms} className="btn-secondary text-xs py-1">
          Formulare
        </Link>
      )}
      <Link
        href={`/staff/clients/${client.id}/change-requests`}
        className="btn-secondary text-xs py-1"
      >
        Stammdaten-Änderungen
        {pendingChangeRequests > 0 && (
          <span className="badge-yellow ml-2">{pendingChangeRequests}</span>
        )}
      </Link>
    </nav>
  );
}

/** Subsumtion/TCMS nur, wenn die Signal-Engine ihren Healthcheck beantwortet. */
async function SubsumtionNavLink({ clientId }: { clientId: string }) {
  if (!(await isRiskLayerAvailable())) return null;
  return (
    <Link href={`/staff/clients/${clientId}/subsumtion`} className="btn-secondary text-xs py-1">
      Subsumtion / TCMS
    </Link>
  );
}
