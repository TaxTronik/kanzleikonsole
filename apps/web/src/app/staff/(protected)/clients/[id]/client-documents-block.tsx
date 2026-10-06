import Link from 'next/link';
import { Archive } from 'lucide-react';
import type { TenantContext } from '@taxtronik/db';
import type { StaffSession } from '@/server/auth/staff';
import { DocumentExplorer } from '@/components/document-explorer';
import { loadClientDocumentsPage, type ClientDocumentsQuery } from './_data';

interface ClientDocumentsBlockProps {
  ctx: TenantContext;
  session: StaffSession;
  client: { id: string; name: string; allowActive: boolean };
  query: ClientDocumentsQuery;
}

/** Suchbegriff der Dokumentliste in der URL (siehe parseClientDocumentsSearch). */
export const CLIENT_DOCUMENTS_SEARCH_PARAM = 'docsQ';

export function clientDocumentsPageHref(clientId: string, query: ClientDocumentsQuery): string {
  const params = new URLSearchParams();
  if (query.deleted) params.set('docsDeleted', '1');
  if (query.folder !== 'all') params.set('docsFolder', query.folder);
  if (query.q) params.set(CLIENT_DOCUMENTS_SEARCH_PARAM, query.q);
  if (query.page > 1) params.set('docsPage', String(query.page));
  const search = params.toString();
  return `/staff/clients/${clientId}${search ? `?${search}` : ''}#documents`;
}

export async function ClientDocumentsBlock({
  ctx,
  session,
  client,
  query,
}: ClientDocumentsBlockProps) {
  const data = await loadClientDocumentsPage(ctx, session, client.id, query);
  if (!data) return null;
  const hasPrevious = data.page > 1;
  const hasNext = data.page < data.totalPages;
  // Effektiver Zustand (unbekannte Ordner fallen auf „Alle“ zurück).
  const current: ClientDocumentsQuery = {
    page: data.page,
    deleted: data.deleted,
    folder: data.folder,
    q: data.q,
  };
  const hrefFor = (change: Partial<ClientDocumentsQuery>) =>
    clientDocumentsPageHref(client.id, { ...current, page: 1, ...change });
  const folderHrefs: Record<string, string> = {
    all: hrefFor({ folder: 'all' }),
    none: hrefFor({ folder: 'none' }),
    ...Object.fromEntries(
      data.folders.map((folder) => [folder.id, hrefFor({ folder: folder.id })]),
    ),
  };

  return (
    <section id="documents" aria-labelledby="client-documents-heading">
      <div className="flex items-center justify-between mb-3">
        <h2 id="client-documents-heading" className="text-sm font-medium text-primary">
          Dokumente
        </h2>
        {data.hasDatevDocuments && (
          <a
            href={`/api/staff/clients/${client.id}/datev-belege-export`}
            className="btn-secondary text-xs"
            title="Alle GoBD-Belege als ZIP mit Begleitliste"
          >
            <Archive className="h-4 w-4" />
            DATEV-Belege (ZIP)
          </a>
        )}
      </div>

      {!client.allowActive && (
        <p className="text-xs text-yellow-600 mb-2">
          Dokumente können erst nach GwG-Freischaltung hochgeladen werden.
        </p>
      )}

      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span>
          {data.totalCount === 0
            ? 'Keine Dokumente vorhanden.'
            : `${data.from.toLocaleString('de-DE')}–${data.to.toLocaleString('de-DE')} von ${data.totalCount.toLocaleString('de-DE')} ${data.deleted ? 'gelöschten' : 'aktiven'} Dokumenten`}
          {(data.folder !== 'all' || data.q) && ' in der aktuellen Auswahl'}
        </span>
      </div>

      <DocumentExplorer
        variant="embedded"
        clientId={client.id}
        canUpload={client.allowActive}
        scopeLabel={client.name}
        folders={data.folders}
        documents={data.documents}
        serverDeleted={{
          showDeleted: data.deleted,
          activeHref: hrefFor({ deleted: false }),
          deletedHref: hrefFor({ deleted: true }),
        }}
        serverFilter={{
          folder: data.folder,
          q: data.q,
          counts: data.folderCounts,
          folderHrefs,
          searchHref: hrefFor({ q: '' }),
          searchParam: CLIENT_DOCUMENTS_SEARCH_PARAM,
        }}
      />

      {data.totalPages > 1 && (
        <nav className="mt-3 flex items-center justify-between gap-3" aria-label="Dokumentseiten">
          {hasPrevious ? (
            <Link
              href={clientDocumentsPageHref(client.id, { ...current, page: data.page - 1 })}
              scroll={false}
              className="btn-secondary text-xs"
            >
              ← Zurück
            </Link>
          ) : (
            <span className="btn-secondary text-xs pointer-events-none opacity-50" aria-disabled>
              ← Zurück
            </span>
          )}
          <span className="text-xs text-muted">
            Seite {data.page.toLocaleString('de-DE')} von {data.totalPages.toLocaleString('de-DE')}
          </span>
          {hasNext ? (
            <Link
              href={clientDocumentsPageHref(client.id, { ...current, page: data.page + 1 })}
              scroll={false}
              className="btn-secondary text-xs"
            >
              Weiter →
            </Link>
          ) : (
            <span className="btn-secondary text-xs pointer-events-none opacity-50" aria-disabled>
              Weiter →
            </span>
          )}
        </nav>
      )}
    </section>
  );
}

export function ClientDocumentsSkeleton() {
  return (
    <section aria-busy="true" aria-label="Dokumente werden geladen">
      <div className="mb-3 h-5 w-28 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
      <div className="card h-64 animate-pulse bg-gray-50 dark:bg-gray-800" />
    </section>
  );
}
