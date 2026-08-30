import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import { requireStaffPage } from '@/server/auth/staff-page';
import { withTenantContext } from '@taxtronik/db';
import { renderMarkdown } from '@/lib/markdown';
import { fmtDateShort, fmtDateTimeShort } from '@/lib/fmt';
import { DocumentPreviewButton } from '@/components/document-preview';
import { canAccessClientTx, isStaffAdmin } from '@/server/auth/rbac';
import { isPoaExpired } from '@/server/poa/signing-snapshot';
import { RevokePoaForm, SendPoaForm } from './revoke-poa-form';

const statusLabels: Record<string, string> = {
  DRAFT: 'Entwurf',
  SENT: 'Wartet auf Unterschrift',
  SIGNED: 'Unterschrieben',
  REVOKED: 'Widerrufen',
  EXPIRED: 'Abgelaufen',
};

export default async function PoaDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireStaffPage();

  const { id } = await params;
  const { tenantId, staffId } = session.user;

  const poa = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const row = await tx.powerOfAttorney.findUnique({
        where: { id },
        include: { client: true },
      });
      if (row && !(await canAccessClientTx(tx, session, row.clientId))) return null;
      return row;
    },
  );

  if (!poa) notFound();

  const html = renderMarkdown(poa.scope);
  const canManagePoa = isStaffAdmin(session);
  const expiredByDate = isPoaExpired(poa.validUntil);

  return (
    <div className="p-8 max-w-3xl">
      <div className="flex items-start gap-4 mb-6">
        <Link
          href="/staff/poa"
          aria-label="Zurück"
          className="text-disabled hover:text-secondary mt-1"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold text-primary">{poa.subject}</h1>
            {poa.status === 'DRAFT' && (
              <span className="badge-gray">{statusLabels[poa.status]}</span>
            )}
            {poa.status === 'SENT' && (
              <span className="badge-yellow">{statusLabels[poa.status]}</span>
            )}
            {poa.status === 'SIGNED' && (
              <span className="badge-green">{statusLabels[poa.status]}</span>
            )}
            {poa.status === 'REVOKED' && (
              <span className="badge-red">{statusLabels[poa.status]}</span>
            )}
            {poa.status === 'EXPIRED' && (
              <span className="badge-red">{statusLabels[poa.status]}</span>
            )}
          </div>
          <p className="text-muted text-sm">
            <Link href={`/staff/clients/${poa.client.id}`} className="hover:underline">
              {poa.client.name}
            </Link>
            {' · Unterzeichner: '}
            {poa.signerName} ({poa.signerEmail})
          </p>
        </div>
      </div>

      {poa.status === 'SIGNED' && (
        <div className="rounded-md bg-green-50 p-4 border border-green-200 mb-6">
          <div className="flex items-start gap-3">
            <ShieldCheck className="h-5 w-5 text-green-600 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-medium text-green-900">
                Elektronisch unterschrieben am {poa.signedAt && fmtDateTimeShort(poa.signedAt)}
              </p>
              <p className="text-xs text-green-700 mt-1">
                Verfahren: Magic-Link + 6-stelliger E-Mail-Code mit Inhalts-Hash
              </p>
              {poa.signedByIp && <p className="text-xs text-green-700">IP: {poa.signedByIp}</p>}
              {poa.signedContentSha256 && (
                <p className="text-xs text-green-700 break-all mt-1">
                  Inhaltsnachweis SHA-256:{' '}
                  <code>{Buffer.from(poa.signedContentSha256).toString('hex')}</code>
                </p>
              )}
              {poa.signedDocumentVersionId && (
                <p className="text-xs text-green-700 break-all">
                  Bestätigte Dokumentversion: <code>{poa.signedDocumentVersionId}</code>
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {poa.status === 'REVOKED' && (
        <div className="rounded-md bg-red-50 p-4 border border-red-200 mb-6">
          <p className="text-sm font-medium text-red-900">Widerrufen</p>
          {poa.revokedReason && (
            <p className="text-xs text-red-700 mt-1">Begründung: {poa.revokedReason}</p>
          )}
        </div>
      )}

      {expiredByDate && poa.status !== 'EXPIRED' && (
        <div className="rounded-md bg-red-50 p-4 border border-red-200 mb-6 text-sm text-red-800">
          Das Gültigkeitsende ist überschritten. Diese Vollmacht kann nicht mehr versendet oder
          unterschrieben werden.
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="card p-4">
          <p className="eyebrow">Gültig ab</p>
          <p className="text-sm font-medium text-primary">{fmtDateShort(poa.validFrom)}</p>
        </div>
        <div className="card p-4">
          <p className="eyebrow">Gültig bis</p>
          <p className="text-sm font-medium text-primary">
            {poa.validUntil ? fmtDateShort(poa.validUntil) : 'unbefristet'}
          </p>
        </div>
      </div>

      <div className="card p-6 mb-6">
        <h2 className="text-xs font-medium text-muted uppercase tracking-wide mb-3">Vollmacht</h2>
        {poa.documentId ? (
          <div className="flex items-center gap-2">
            <DocumentPreviewButton documentId={poa.documentId} documentTitle={poa.subject} />
            <span className="text-xs text-muted">Externe Vollmacht (PDF)</span>
          </div>
        ) : (
          <div
            className="prose prose-sm max-w-none [&_h1]:text-xl [&_h1]:font-bold [&_h2]:text-lg [&_h2]:font-semibold [&_p]:my-3 [&_ul]:list-disc [&_ul]:ml-6"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {canManagePoa && !expiredByDate && (poa.status === 'DRAFT' || poa.status === 'SENT') && (
          <SendPoaForm
            poaId={poa.id}
            isResend={poa.status === 'SENT'}
            expectedUpdatedAt={poa.updatedAt.toISOString()}
          />
        )}
        {canManagePoa && poa.status !== 'REVOKED' && poa.status !== 'EXPIRED' && (
          <RevokePoaForm poaId={poa.id} subject={poa.subject} />
        )}
      </div>
    </div>
  );
}
