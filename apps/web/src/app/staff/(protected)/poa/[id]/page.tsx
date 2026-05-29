import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Send, X, ShieldCheck } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { sendForSignatureAction, revokePoaAction } from '../actions';
import { renderMarkdown } from '@/lib/markdown';
import { fmtDateShort, fmtDateTimeShort } from '@/lib/fmt';

const statusLabels: Record<string, string> = {
  DRAFT: 'Entwurf',
  SENT: 'Wartet auf Unterschrift',
  SIGNED: 'Unterschrieben',
  REVOKED: 'Widerrufen',
  EXPIRED: 'Abgelaufen',
};

export default async function PoaDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');

  const { id } = await params;
  const { tenantId, staffId } = session.user;

  const poa = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) =>
      tx.powerOfAttorney.findUnique({
        where: { id },
        include: { client: true },
      }),
  );

  if (!poa) notFound();

  const html = renderMarkdown(poa.scope);

  return (
    <div className="p-8 max-w-3xl">
      <div className="flex items-start gap-4 mb-6">
        <Link href="/staff/poa" className="text-disabled hover:text-secondary mt-1">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold text-primary">{poa.subject}</h1>
            {poa.status === 'DRAFT' && <span className="badge-gray">{statusLabels[poa.status]}</span>}
            {poa.status === 'SENT' && <span className="badge-yellow">{statusLabels[poa.status]}</span>}
            {poa.status === 'SIGNED' && <span className="badge-green">{statusLabels[poa.status]}</span>}
            {poa.status === 'REVOKED' && <span className="badge-red">{statusLabels[poa.status]}</span>}
            {poa.status === 'EXPIRED' && <span className="badge-red">{statusLabels[poa.status]}</span>}
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
                Elektronisch unterschrieben am{' '}
                {poa.signedAt && fmtDateTimeShort(poa.signedAt)}
              </p>
              <p className="text-xs text-green-700 mt-1">
                Verfahren: Magic-Link + 6-stelliger E-Mail-OTP (eIDAS AES)
              </p>
              {poa.signedByIp && (
                <p className="text-xs text-green-700">IP: {poa.signedByIp}</p>
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

      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="card p-4">
          <p className="eyebrow">Gültig ab</p>
          <p className="text-sm font-medium text-primary">
            {fmtDateShort(poa.validFrom)}
          </p>
        </div>
        <div className="card p-4">
          <p className="eyebrow">Gültig bis</p>
          <p className="text-sm font-medium text-primary">
            {poa.validUntil ? fmtDateShort(poa.validUntil) : 'unbefristet'}
          </p>
        </div>
      </div>

      <div className="card p-6 mb-6">
        <h2 className="text-xs font-medium text-muted uppercase tracking-wide mb-3">
          Vollmachtsumfang
        </h2>
        <div
          className="prose prose-sm max-w-none [&_h1]:text-xl [&_h1]:font-bold [&_h2]:text-lg [&_h2]:font-semibold [&_p]:my-3 [&_ul]:list-disc [&_ul]:ml-6"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        {(poa.status === 'DRAFT' || poa.status === 'SENT') && (
          <form action={async (fd) => {
            'use server';
            await sendForSignatureAction(fd);
          }}>
            <input type="hidden" name="poaId" value={poa.id} />
            <button type="submit" className="btn-primary">
              <Send className="h-4 w-4" />
              {poa.status === 'SENT' ? 'Erneut senden' : 'Zur Unterschrift senden'}
            </button>
          </form>
        )}
        {poa.status !== 'REVOKED' && poa.status !== 'EXPIRED' && (
          <form action={revokePoaAction} className="flex gap-2">
            <input type="hidden" name="poaId" value={poa.id} />
            <input
              name="reason"
              type="text"
              className="input flex-1"
              placeholder="Widerrufsgrund (Pflicht)"
              required
              minLength={1}
              maxLength={2000}
            />
            <button type="submit" className="btn-secondary text-red-700 border-red-300 hover:bg-red-50">
              <X className="h-4 w-4" />
              Widerrufen
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
