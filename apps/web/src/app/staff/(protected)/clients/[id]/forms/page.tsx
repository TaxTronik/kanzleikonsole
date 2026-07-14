// =============================================================================
// /staff/clients/[id]/forms — Formular-Anfragen pro Mandant
// =============================================================================

import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, ClipboardList } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { SendFormButton } from './send-form';
import { fmtDateTimeShort } from '@/lib/fmt';

const STATUS_LABELS: Record<string, string> = {
  PENDING: 'Ausstehend',
  DRAFT: 'Entwurf',
  SUBMITTED: 'Eingegangen',
  REVIEWED: 'Geprüft',
};

export default async function ClientFormsPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  const { id: clientId } = await params;
  const { tenantId, staffId } = session.user;

  const data = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const client = await tx.client.findUnique({
        where: { id: clientId },
        select: { id: true, name: true },
      });
      if (!client) return null;
      const [submissions, templates] = await Promise.all([
        tx.formSubmission.findMany({
          where: { clientId },
          orderBy: { createdAt: 'desc' },
        }),
        tx.formTemplate.findMany({
          where: { active: true },
          orderBy: { name: 'asc' },
          select: { id: true, name: true, _count: { select: { fields: true } } },
        }),
      ]);
      return { client, submissions, templates };
    },
  );
  if (!data) notFound();
  const { client, submissions, templates } = data;

  return (
    <div className="p-8 max-w-5xl">
      <Link href={`/staff/clients/${clientId}`} className="back-link">
        <ArrowLeft className="h-4 w-4" /> Zurück
      </Link>

      <div className="flex items-end justify-between mb-6">
        <div>
          <h1 className="page-title">
            <ClipboardList className="h-6 w-6 text-brand-600" />
            Formulare
          </h1>
          <p className="text-muted text-sm">{client.name}</p>
        </div>
        <SendFormButton clientId={clientId} templates={templates} />
      </div>

      {submissions.length === 0 ? (
        <div className="card p-10 text-center">
          <p className="text-sm text-disabled">Noch keine Formular-Anfragen an diesen Mandanten.</p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-default">
                <th className="text-left px-6 py-3 text-xs font-medium text-muted uppercase">
                  Vorlage
                </th>
                <th className="text-left px-6 py-3 text-xs font-medium text-muted uppercase">
                  Versendet
                </th>
                <th className="text-left px-6 py-3 text-xs font-medium text-muted uppercase">
                  Eingegangen
                </th>
                <th className="text-left px-6 py-3 text-xs font-medium text-muted uppercase">
                  Status
                </th>
                <th className="text-right px-6 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {submissions.map((s) => (
                <tr key={s.id} className="hover:bg-gray-50">
                  <td className="px-6 py-3 font-medium text-primary">{s.name}</td>
                  <td className="px-6 py-3 text-secondary">{fmtDateTimeShort(s.createdAt)}</td>
                  <td className="px-6 py-3 text-secondary">
                    {s.submittedAt ? fmtDateTimeShort(s.submittedAt) : '—'}
                  </td>
                  <td className="px-6 py-3">
                    {s.status === 'PENDING' && (
                      <span className="badge-yellow">{STATUS_LABELS[s.status]}</span>
                    )}
                    {s.status === 'DRAFT' && (
                      <span className="badge-yellow">{STATUS_LABELS[s.status]}</span>
                    )}
                    {s.status === 'SUBMITTED' && (
                      <span className="badge-green">{STATUS_LABELS[s.status]}</span>
                    )}
                    {s.status === 'REVIEWED' && (
                      <span className="badge-gray">{STATUS_LABELS[s.status]}</span>
                    )}
                  </td>
                  <td className="px-6 py-3 text-right">
                    <Link
                      href={`/staff/forms/submissions/${s.id}`}
                      className="text-xs text-brand-700 hover:underline"
                    >
                      Öffnen
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
