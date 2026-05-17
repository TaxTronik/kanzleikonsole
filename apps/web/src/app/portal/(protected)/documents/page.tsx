import { redirect } from 'next/navigation';
import { FileText } from 'lucide-react';
import { portalAuth } from '@/server/auth/portal';
import { withTenantContext } from '@taxtronik/db';
import { DocumentPreviewButton } from '@/components/document-preview';

const classificationLabels: Record<string, string> = {
  GOBD_INVOICE: 'Rechnung',
  GOBD_CONTRACT: 'Vertrag',
  GOBD_TAX: 'Steuer',
  GWG_EVIDENCE: 'GwG-Nachweis',
  GENERAL: 'Allgemein',
};

export default async function PortalDocumentsPage() {
  const session = await portalAuth();
  if (!session?.user) redirect('/portal/login');

  const { tenantId, contactId, clientId } = session.user;

  const documents = await withTenantContext(
    { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' },
    (tx) =>
      tx.document.findMany({
        // Soft-gelöschte Dokumente nie im Mandanten-Portal zeigen.
        // Opt-in-Sharing: nur vom Staff freigegebene (oder vom Mandanten
        // selbst hochgeladene, dann auto-geteilte) Dokumente sind sichtbar.
        where: { clientId, deletedAt: null, sharedWithClientAt: { not: null } },
        orderBy: { createdAt: 'desc' },
        include: {
          versions: {
            orderBy: { versionNo: 'desc' },
            take: 1,
            select: { sizeBytes: true },
          },
        },
        take: 100,
      }),
  );

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Dokumente</h1>
      <p className="text-gray-500 text-sm mb-6">
        Dokumente, die zwischen Ihnen und Ihrer Kanzlei ausgetauscht wurden.
      </p>

      <div className="card overflow-hidden">
        {documents.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <FileText className="h-12 w-12 text-gray-200 mx-auto mb-3" />
            <p className="text-sm text-gray-400">Noch keine Dokumente.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Titel</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Typ</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Größe</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Datum</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {documents.map((d) => {
                const v = d.versions[0];
                return (
                  <tr key={d.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 font-medium text-gray-900">
                      <div className="flex items-center gap-2">
                        <DocumentPreviewButton
                          documentId={d.id}
                          documentTitle={d.title}
                          apiPrefix="/api/portal"
                        />
                        <a
                          href={`/api/portal/documents/${d.id}/download`}
                          className="hover:underline"
                        >
                          {d.title}
                        </a>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-gray-600">
                      {classificationLabels[d.classification] ?? d.classification}
                    </td>
                    <td className="px-6 py-4 text-gray-600">
                      {v ? formatBytes(Number(v.sizeBytes)) : '—'}
                    </td>
                    <td className="px-6 py-4 text-gray-600">
                      {new Intl.DateTimeFormat('de-DE').format(d.createdAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}
