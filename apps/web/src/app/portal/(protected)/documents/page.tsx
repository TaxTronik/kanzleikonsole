import { redirect } from 'next/navigation';
import { FileText } from 'lucide-react';
import { portalAuth } from '@/server/auth/portal';
import { withTenantContext } from '@taxtronik/db';
import { DocumentPreviewButton } from '@/components/document-preview';
import { fmtBytes, fmtDateShort } from '@/lib/fmt';
import { DOCUMENT_CLASSIFICATION_LABELS } from '@/lib/domain-labels';

const portalClassificationLabels: Readonly<Record<string, string>> = {
  ...DOCUMENT_CLASSIFICATION_LABELS,
  GOBD_INVOICE: 'Rechnung',
  GOBD_CONTRACT: 'Vertrag',
  GOBD_TAX: 'Steuer',
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
      <h1 className="text-2xl font-bold text-primary mb-1">Dokumente</h1>
      <p className="text-muted text-sm mb-6">
        Dokumente, die zwischen Ihnen und Ihrer Kanzlei ausgetauscht wurden.
      </p>

      <div className="card overflow-hidden">
        {documents.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <FileText className="h-12 w-12 text-disabled mx-auto mb-3" />
            <p className="text-sm text-disabled">Noch keine Dokumente.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-default">
                <th className="th">Titel</th>
                <th className="th">Typ</th>
                <th className="th">Größe</th>
                <th className="th">Datum</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {documents.map((d) => {
                const v = d.versions[0];
                return (
                  <tr key={d.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 font-medium text-primary">
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
                    <td className="px-6 py-4 text-secondary">
                      {portalClassificationLabels[d.classification] ?? d.classification}
                    </td>
                    <td className="px-6 py-4 text-secondary">
                      {v ? fmtBytes(Number(v.sizeBytes)) : '—'}
                    </td>
                    <td className="px-6 py-4 text-secondary">{fmtDateShort(d.createdAt)}</td>
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
