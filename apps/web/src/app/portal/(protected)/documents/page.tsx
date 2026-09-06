import type { DocumentClassification, Prisma } from '@prisma/client';
import { withTenantContext } from '@taxtronik/db';
import { FileText, Search } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { DocumentPreviewButton } from '@/components/document-preview';
import { OffsetPagination } from '@/components/offset-pagination';
import { DOCUMENT_CLASSIFICATION_LABELS } from '@/lib/domain-labels';
import { fmtBytes, fmtDateShort } from '@/lib/fmt';
import { portalAuth } from '@/server/auth/portal';
import {
  PORTAL_LIST_PAGE_SIZE,
  clampPortalListPage,
  escapePortalContainsQuery,
  firstPortalSearchParam,
  normalizePortalListQuery,
  parsePortalListPage,
} from '@/server/portal/list-query';

const portalClassificationLabels: Readonly<Record<DocumentClassification, string>> = {
  GOBD_INVOICE: 'Rechnung',
  GOBD_CONTRACT: 'Vertrag',
  GOBD_TAX: 'Steuer',
  GWG_EVIDENCE: DOCUMENT_CLASSIFICATION_LABELS.GWG_EVIDENCE ?? 'GwG-Nachweis',
  PERSONNEL: DOCUMENT_CLASSIFICATION_LABELS.PERSONNEL ?? 'Personal',
  STAFF_PRIVATE: DOCUMENT_CLASSIFICATION_LABELS.STAFF_PRIVATE ?? 'Intern',
  GENERAL: DOCUMENT_CLASSIFICATION_LABELS.GENERAL ?? 'Allgemein',
};

const classifications = Object.keys(portalClassificationLabels) as DocumentClassification[];
type SearchParams = Record<string, string | string[] | undefined>;

export default async function PortalDocumentsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await portalAuth();
  if (!session?.user) redirect('/portal/login');

  const { tenantId, contactId, clientId } = session.user;
  const sp = await searchParams;
  const query = normalizePortalListQuery(sp.q);
  const requestedPage = parsePortalListPage(sp.page);
  const classificationInput = firstPortalSearchParam(sp.classification);
  const classification = classifications.includes(classificationInput as DocumentClassification)
    ? (classificationInput as DocumentClassification)
    : null;
  const containsQuery = escapePortalContainsQuery(query);

  const { documents, totalCount, page } = await withTenantContext(
    { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' },
    async (tx) => {
      // Fachkatalog DOC-PORTAL-SHARING-001: exakt derselbe Mandanten-,
      // Freigabe- und Löschfilter wie Download und Vorschau. RLS bleibt als
      // zusätzlicher Schutz für speziell klassifizierte Dokumente aktiv.
      const where: Prisma.DocumentWhereInput = {
        clientId,
        deletedAt: null,
        sharedWithClientAt: { not: null },
        // `loadDocumentDelivery` verweigert diese Dokumente jedem Portalakteur
        // ebenfalls explizit; die Liste darf sich nicht allein auf RLS stützen.
        requiresPayrollAccess: false,
        ...(classification ? { classification } : {}),
        ...(query ? { title: { contains: containsQuery, mode: 'insensitive' } } : {}),
      };
      const count = await tx.document.count({ where });
      const safePage = clampPortalListPage(requestedPage, count);
      const rows = await tx.document.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (safePage - 1) * PORTAL_LIST_PAGE_SIZE,
        take: PORTAL_LIST_PAGE_SIZE,
        include: {
          versions: {
            orderBy: { versionNo: 'desc' },
            take: 1,
            select: { sizeBytes: true },
          },
        },
      });
      return { documents: rows, totalCount: count, page: safePage };
    },
  );

  const baseQs = new URLSearchParams();
  if (query) baseQs.set('q', query);
  if (classification) baseQs.set('classification', classification);
  const hasFilters = Boolean(query || classification);

  return (
    <div className="p-4 sm:p-8">
      <h1 className="text-2xl font-bold text-primary mb-1">Dokumente</h1>
      <p className="text-muted text-sm mb-6">
        Dokumente, die zwischen Ihnen und Ihrer Kanzlei ausgetauscht wurden.
      </p>

      <form action="/portal/documents" method="get" className="card p-4 mb-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_14rem_auto] sm:items-end">
          <div className="relative">
            <label className="sr-only" htmlFor="portal-document-search">
              Dokumente durchsuchen
            </label>
            <Search
              aria-hidden="true"
              className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-disabled"
            />
            <input
              id="portal-document-search"
              type="search"
              name="q"
              className="input pl-9"
              defaultValue={query}
              maxLength={120}
              placeholder="Dokumenttitel"
            />
          </div>
          <div>
            <label className="sr-only" htmlFor="portal-document-classification">
              Dokumenttyp filtern
            </label>
            <select
              id="portal-document-classification"
              name="classification"
              className="input"
              defaultValue={classification ?? ''}
            >
              <option value="">Alle Typen</option>
              {classifications.map((value) => (
                <option key={value} value={value}>
                  {portalClassificationLabels[value]}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            {hasFilters ? (
              <Link href="/portal/documents" className="btn-secondary flex-1 sm:flex-none">
                Zurücksetzen
              </Link>
            ) : null}
            <button type="submit" className="btn-primary flex-1 sm:flex-none">
              Anwenden
            </button>
          </div>
        </div>
      </form>

      <div className="card overflow-hidden">
        {documents.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <FileText className="h-12 w-12 text-disabled mx-auto mb-3" />
            <p className="text-sm text-disabled">Keine Dokumente gefunden.</p>
          </div>
        ) : (
          <>
            <ul className="divide-y divide-border-subtle md:hidden">
              {documents.map((document) => {
                const version = document.versions[0];
                return (
                  <li key={document.id} className="p-4">
                    <div className="flex min-w-0 items-start gap-2">
                      <DocumentPreviewButton
                        documentId={document.id}
                        documentTitle={document.title}
                        apiPrefix="/api/portal"
                      />
                      <div className="min-w-0">
                        <a
                          href={`/api/portal/documents/${document.id}/download`}
                          className="block break-words font-medium text-primary hover:underline"
                        >
                          {document.title}
                        </a>
                        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted">
                          <div>
                            <dt className="sr-only">Typ</dt>
                            <dd>{portalClassificationLabels[document.classification]}</dd>
                          </div>
                          <div className="text-right">
                            <dt className="sr-only">Datum</dt>
                            <dd>{fmtDateShort(document.createdAt)}</dd>
                          </div>
                          <div>
                            <dt className="sr-only">Größe</dt>
                            <dd>{version ? fmtBytes(Number(version.sizeBytes)) : '—'}</dd>
                          </div>
                        </dl>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
            <table className="hidden w-full text-sm md:table">
              <thead>
                <tr className="bg-gray-50 border-b border-default">
                  <th className="th">Titel</th>
                  <th className="th">Typ</th>
                  <th className="th">Größe</th>
                  <th className="th">Datum</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {documents.map((document) => {
                  const version = document.versions[0];
                  return (
                    <tr key={document.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 font-medium text-primary">
                        <div className="flex items-center gap-2">
                          <DocumentPreviewButton
                            documentId={document.id}
                            documentTitle={document.title}
                            apiPrefix="/api/portal"
                          />
                          <a
                            href={`/api/portal/documents/${document.id}/download`}
                            className="break-words hover:underline"
                          >
                            {document.title}
                          </a>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-secondary">
                        {portalClassificationLabels[document.classification]}
                      </td>
                      <td className="px-6 py-4 text-secondary">
                        {version ? fmtBytes(Number(version.sizeBytes)) : '—'}
                      </td>
                      <td className="px-6 py-4 text-secondary">
                        {fmtDateShort(document.createdAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <OffsetPagination
              basePath="/portal/documents"
              baseQs={baseQs}
              page={page}
              pageSize={PORTAL_LIST_PAGE_SIZE}
              totalCount={totalCount}
            />
          </>
        )}
      </div>
    </div>
  );
}
