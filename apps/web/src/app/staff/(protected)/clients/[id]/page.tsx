import { Suspense, type ReactNode } from 'react';
import { randomUUID } from 'node:crypto';
import { requireClientPageAccess } from '@/server/auth/client-page-access';
import { isStaffAdmin } from '@/server/auth/rbac';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Wand2 } from 'lucide-react';
import { computeOnboardingStatus, resumeStep } from '@/server/onboarding/status';
import { readModules } from '@/server/settings/modules';
import { resolveClientNavigation } from '@/lib/navigation-registry';
import { isRiskLayerAvailable } from '@/server/risk/availability';
import { readClientLayout, type ClientBlockKey } from '@/server/settings/client-layout';
import { CockpitGrid } from './cockpit-grid';
import { isElsterConfigured } from '@taxtronik/elster';
import { ClientContactsPanel } from '@/components/client-contacts-panel';
import { fmtDateShort, fmtEUR } from '@/lib/fmt';
import { RecordClientVisit } from '@/components/recent-clients';
import { QuickRequestDialog } from '@/components/quick-request-dialog';
import {
  loadClientCockpitBlocks,
  loadClientCockpitHeader,
  parseClientDocumentsDeleted,
  parseClientDocumentsFolder,
  parseClientDocumentsPage,
  parseClientDocumentsSearch,
  type ClientDocumentsQuery,
} from './_data';
import { ClientDocumentsBlock, ClientDocumentsSkeleton } from './client-documents-block';
import {
  BindersCockpitBlock,
  CockpitBlockSkeleton,
  HandoversCockpitBlock,
  PhoneNotesCockpitBlock,
  RemindersCockpitBlock,
  RequestsCockpitBlock,
  UpcomingCockpitBlock,
  WorkflowsCockpitBlock,
} from './cockpit-blocks';

const kindLabels: Record<string, string> = {
  NATPERS: 'Natürliche Person',
  JURPERS: 'Juristische Person',
  PERSGES: 'Personengesellschaft',
};

function formatCustomValue(type: string, value: unknown): ReactNode {
  if (value === null || value === undefined || value === '') {
    return <span className="text-disabled font-normal">—</span>;
  }
  if (type === 'CHECKBOX') return value ? 'Ja' : 'Nein';
  if (type === 'MONEY' && typeof value === 'number') return fmtEUR(value);
  if (type === 'NUMBER' && typeof value === 'number') return value.toLocaleString('de-DE');
  if (type === 'DATE' && typeof value === 'string') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : fmtDateShort(d);
  }
  if (type === 'URL' && typeof value === 'string') {
    return (
      <a
        href={value}
        target="_blank"
        rel="noopener noreferrer"
        className="text-brand-700 hover:underline"
      >
        {value}
      </a>
    );
  }
  return String(value);
}

interface ClientDetailSearchParams {
  docsPage?: string | string[];
  docsDeleted?: string | string[];
  docsFolder?: string | string[];
  docsQ?: string | string[];
}

export default async function ClientDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<ClientDetailSearchParams>;
}) {
  const [{ id }, search] = await Promise.all([params, searchParams]);
  const session = await requireClientPageAccess(id);
  const now = new Date();

  // Dokumentliste: Seite, Gelöscht-Ansicht, Ordner und Suche aus der URL —
  // gefiltert wird serverseitig über alle Dokumente des Mandanten.
  const documentsQuery: ClientDocumentsQuery = {
    page: parseClientDocumentsPage(search.docsPage),
    deleted: parseClientDocumentsDeleted(search.docsDeleted),
    folder: parseClientDocumentsFolder(search.docsFolder),
    q: parseClientDocumentsSearch(search.docsQ),
  };
  const { tenantId, staffId } = session.user;
  const settingsCtx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };

  // Module stammen aus den request-scoped Layout-Einstellungen (meist schon geladen).
  const modules = await readModules(settingsCtx);
  const clientNav = resolveClientNavigation(modules, id);
  // P-07: Die Blockdaten laufen in eigener Tenant-Transaktion (mit eigenem
  // Zugriffs-Backstop) parallel zum Kopf und streamen in <Suspense>. Fehler
  // erreichen die Blöcke; das catch verhindert nur einen unbehandelten Reject,
  // falls der Loader scheitert, bevor ein Block ihn abwartet.
  const blocks = loadClientCockpitBlocks(settingsCtx, session, id, modules, now);
  blocks.catch(() => undefined);
  const [clientLayout, header] = await Promise.all([
    readClientLayout(settingsCtx),
    loadClientCockpitHeader(settingsCtx, session, id),
  ]);

  if (header.status === 'forbidden') redirect('/staff/clients?denied=1');
  if (header.status === 'not_found') notFound();
  const {
    client,
    pendingChangeRequests,
    customDefs,
    customValues,
    requestTemplates,
    requestFormTemplates,
    templatesLimited,
    formTemplatesLimited,
  } = header.data;

  // Subsumtion/TCMS: Admin/Partner ODER dem Mandanten zugeordneter
  // Berufsträger/Hauptbearbeiter (+ aktives Modul) sehen die Nav-Pill.
  const canSubsumtion =
    isStaffAdmin(session) ||
    client.responsibilities.some(
      (r) => r.staff.id === staffId && (r.role === 'BERUFSTRAEGER' || r.role === 'HAUPTBEARBEITER'),
    );

  const customDefsForKind = customDefs.filter(
    (d) => d.appliesTo.length === 0 || d.appliesTo.includes(client.kind),
  );
  const customValuesById = new Map(customValues.map((v) => [v.fieldId, v.value]));

  return (
    <div className="p-8">
      <RecordClientVisit tenantId={tenantId} staffId={staffId} id={client.id} />
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
          {(() => {
            const berufstraeger = client.responsibilities.filter((r) => r.role === 'BERUFSTRAEGER');
            const bearbeiter = client.responsibilities.filter((r) => r.role === 'HAUPTBEARBEITER');
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
          })()}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <QuickRequestDialog
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

      {(() => {
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
      })()}

      {/* Navigation als horizontale Pill-Leiste — spart vertikalen Platz.
          Modulabhängige Reiter kommen aus der Modul-Registry (wie Route-Gate
          und Seiten-Gate der Zielseiten). */}
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
            {client._count.poas > 0 && (
              <span className="badge-gray ml-2">{client._count.poas}</span>
            )}
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

      {/* Mandanten-Grid — alle Karten in der Reihenfolge/Position aus tenant_setting.client_detail.layout.
          Kopfdaten-Karten rendern sofort; die übrigen streamen je in eigener <Suspense>-Grenze. */}
      {(() => {
        const clientRef = { id: client.id, name: client.name };
        const blockNodes: Record<ClientBlockKey, ReactNode> = {
          upcoming:
            modules.taxNotices || modules.appointments ? (
              <Suspense fallback={<CockpitBlockSkeleton title="Anstehende Termine" />}>
                <UpcomingCockpitBlock
                  blocks={blocks}
                  client={clientRef}
                  showTax={modules.taxNotices}
                  showAppts={modules.appointments}
                  staffId={staffId}
                  now={now}
                />
              </Suspense>
            ) : null,
          workflows: !modules.workflows ? null : (
            <Suspense fallback={<CockpitBlockSkeleton title="Aktive Workflows" />}>
              <WorkflowsCockpitBlock blocks={blocks} clientId={client.id} now={now} />
            </Suspense>
          ),
          reminders: !modules.reminders ? null : (
            <Suspense fallback={<CockpitBlockSkeleton title="Wiedervorlagen" />}>
              <RemindersCockpitBlock
                blocks={blocks}
                clientId={client.id}
                staffId={staffId}
                isAdmin={isStaffAdmin(session)}
              />
            </Suspense>
          ),
          binders: !modules.binders ? null : (
            <Suspense fallback={<CockpitBlockSkeleton title="Pendelordner" />}>
              <BindersCockpitBlock blocks={blocks} clientId={client.id} />
            </Suspense>
          ),
          handovers: !modules.handovers ? null : (
            <Suspense fallback={<CockpitBlockSkeleton title="Anlieferungen" />}>
              <HandoversCockpitBlock blocks={blocks} clientId={client.id} />
            </Suspense>
          ),
          phone_notes: !modules.phoneNotes ? null : (
            <Suspense fallback={<CockpitBlockSkeleton title="Telefonzettel" />}>
              <PhoneNotesCockpitBlock
                blocks={blocks}
                clientId={client.id}
                contacts={client.contacts.map((c) => ({ fullName: c.fullName, phone: c.phone }))}
                staffId={staffId}
              />
            </Suspense>
          ),
          contacts: (
            <ClientContactsPanel
              key="contacts"
              clientId={client.id}
              contacts={client.contacts.map((c) => ({
                id: c.id,
                email: c.email,
                fullName: c.fullName,
                phone: c.phone,
                role: c.role,
                lastLoginAt: c.lastLoginAt,
              }))}
            />
          ),
          master_data: (
            <div key="master_data" className="card p-6">
              <h2 className="text-sm font-medium text-muted uppercase tracking-wide mb-4">
                Stammdaten
              </h2>
              <dl className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <dt className="text-muted">Typ</dt>
                  <dd className="text-primary font-medium">{kindLabels[client.kind]}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted">DATEV-Nr.</dt>
                  <dd className="text-primary font-medium">{client.datevNo ?? '—'}</dd>
                </div>
                {client.addisonNo && (
                  <div className="flex justify-between">
                    <dt className="text-muted">Addison-Nr.</dt>
                    <dd className="text-primary font-medium">{client.addisonNo}</dd>
                  </div>
                )}
                <div className="flex justify-between">
                  <dt className="text-muted">Angelegt</dt>
                  <dd className="text-primary font-medium">{fmtDateShort(client.createdAt)}</dd>
                </div>
              </dl>
            </div>
          ),
          custom_fields:
            customDefsForKind.length === 0 ? null : (
              <div key="custom_fields" className="card p-6">
                <h2 className="text-sm font-medium text-muted uppercase tracking-wide mb-4">
                  Custom-Felder
                </h2>
                <dl className="space-y-3 text-sm">
                  {customDefsForKind.map((d) => (
                    <div key={d.id} className="flex justify-between gap-3">
                      <dt className="text-muted">{d.label}</dt>
                      <dd className="text-primary font-medium text-right break-words">
                        {formatCustomValue(d.type, customValuesById.get(d.id))}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ),
          gwg_status: (
            <div key="gwg_status" className="card p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-medium text-muted uppercase tracking-wide">
                  GwG-Status
                </h2>
                <Link
                  href={`/staff/clients/${client.id}/gwg`}
                  className="text-xs text-brand-700 hover:underline"
                >
                  Prüfung öffnen →
                </Link>
              </div>
              {(() => {
                const latest = client.gwgChecks[0];
                if (!latest) {
                  return (
                    <p className="text-sm text-secondary">
                      Noch keine Prüfung. Erst nach Verifikation kann der Mandant aktiv werden.
                    </p>
                  );
                }
                const isExpiring =
                  latest.validUntil &&
                  latest.validUntil.getTime() - now.getTime() < 30 * 24 * 60 * 60 * 1000;
                return (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      {latest.status === 'VERIFIED' && (
                        <span className="badge-green">Verifiziert</span>
                      )}
                      {latest.status === 'IN_REVIEW' && (
                        <span className="badge-yellow">In Prüfung</span>
                      )}
                      {latest.status === 'DRAFT' && <span className="badge-gray">Entwurf</span>}
                      {latest.status === 'REJECTED' && <span className="badge-red">Abgelehnt</span>}
                      {latest.status === 'EXPIRED' && <span className="badge-red">Abgelaufen</span>}
                      {latest.riskLevel === 'HIGH' && (
                        <span className="badge-red">Risiko: HIGH</span>
                      )}
                      {latest.riskLevel === 'MEDIUM' && (
                        <span className="badge-yellow">Risiko: MEDIUM</span>
                      )}
                      {latest.riskLevel === 'LOW' && (
                        <span className="badge-green">Risiko: LOW</span>
                      )}
                    </div>
                    {latest.validUntil && (
                      <p className={isExpiring ? 'text-xs text-yellow-700' : 'text-xs text-muted'}>
                        Gültig bis {fmtDateShort(latest.validUntil)}
                        {isExpiring && ' · läuft bald aus'}
                      </p>
                    )}
                  </div>
                );
              })()}
            </div>
          ),
          requests: (
            <Suspense fallback={<CockpitBlockSkeleton title="Anforderungen" />}>
              <RequestsCockpitBlock blocks={blocks} client={clientRef} />
            </Suspense>
          ),
          documents: (
            <Suspense
              key={`client-documents-${JSON.stringify(documentsQuery)}`}
              fallback={<ClientDocumentsSkeleton />}
            >
              <ClientDocumentsBlock
                ctx={settingsCtx}
                session={session}
                client={{ id: client.id, name: client.name, allowActive: client.allowActive }}
                query={documentsQuery}
              />
            </Suspense>
          ),
        };
        return (
          <div className="mb-8">
            <CockpitGrid items={clientLayout.items} blocks={blockNodes} />
          </div>
        );
      })()}
    </div>
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
      {kindLabels[kind] ?? kind}
      {datevNo ? ` · DATEV ${datevNo}` : ''}
      {addisonNo ? ` · Addison ${addisonNo}` : ''}
    </p>
  );
}
