import { requireClientPageAccess } from '@/server/auth/client-page-access';
import { isStaffAdmin } from '@/server/auth/rbac';
import { redirect, notFound } from 'next/navigation';
import { readModules } from '@/server/settings/modules';
import { resolveClientNavigation } from '@/lib/navigation-registry';
import { readClientLayout } from '@/server/settings/client-layout';
import { CockpitGrid } from './cockpit-grid';
import { RecordClientVisit } from '@/components/recent-clients';
import {
  loadClientCockpitHeader,
  parseClientDocumentsDeleted,
  parseClientDocumentsFolder,
  parseClientDocumentsPage,
  parseClientDocumentsSearch,
  startClientCockpitBlocks,
  type ClientDocumentsQuery,
} from './_data';
import {
  ClientCockpitHeader,
  ClientCockpitNav,
  ClientOnboardingBanner,
  canOpenSubsumtion,
} from './cockpit-header';
import { cockpitBlockNodes } from './cockpit-layout';

interface ClientDetailSearchParams {
  docsPage?: string | string[];
  docsDeleted?: string | string[];
  docsFolder?: string | string[];
  docsQ?: string | string[];
}

// Review-Befund K-04: Die Seite löst nur Mandant und Zugriff auf und legt das
// Cockpit aus. Kopf, Navigation und Karten sind eigene Komponenten
// (cockpit-header.tsx, cockpit-cards.tsx); jeder gestreamte Block hat seinen
// eigenen Loader und seine eigene <Suspense>-Grenze (cockpit-layout.tsx).
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
  // P-07/K-04: Die Blockdaten laufen in eigener Tenant-Transaktion (mit eigenem
  // Zugriffs-Backstop) parallel zum Kopf, ein Promise je Block; jeder Block
  // streamt in seiner <Suspense>-Grenze, sobald seine Daten da sind.
  const blocks = startClientCockpitBlocks(settingsCtx, session, id, modules, now);
  const [clientLayout, header] = await Promise.all([
    readClientLayout(settingsCtx),
    loadClientCockpitHeader(settingsCtx, session, id),
  ]);

  if (header.status === 'forbidden') redirect('/staff/clients?denied=1');
  if (header.status === 'not_found') notFound();
  const { client, pendingChangeRequests } = header.data;
  const isAdmin = isStaffAdmin(session);

  return (
    <div className="p-8">
      <RecordClientVisit tenantId={tenantId} staffId={staffId} id={client.id} />
      <ClientCockpitHeader header={header.data} />
      <ClientOnboardingBanner client={client} />
      <ClientCockpitNav
        client={client}
        clientNav={resolveClientNavigation(modules, id)}
        pendingChangeRequests={pendingChangeRequests}
        canSubsumtion={canOpenSubsumtion(isAdmin, staffId, client.responsibilities)}
      />

      {/* Mandanten-Grid — alle Karten in der Reihenfolge/Position aus tenant_setting.client_detail.layout.
          Kopfdaten-Karten rendern sofort; die übrigen streamen je in eigener <Suspense>-Grenze. */}
      <div className="mb-8">
        <CockpitGrid
          items={clientLayout.items}
          blocks={cockpitBlockNodes({
            header: header.data,
            modules,
            blocks,
            ctx: settingsCtx,
            session,
            documentsQuery,
            staffId,
            isAdmin,
            now,
          })}
        />
      </div>
    </div>
  );
}
