// =============================================================================
// /staff/clients/:id/change-requests
//
// Stammdaten-Änderungsanfragen des Mandanten genehmigen oder ablehnen.
// Genehmigung schreibt die Felder atomar auf den Client; sind GwG-relevante
// Felder (Name, Adresse, USt-ID) betroffen, wird der GwG-Check auf
// IN_REVIEW zurückgesetzt — analog zur Staff-Edit-Logik.
// =============================================================================

import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, CheckCircle2, Clock, XCircle } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { ChangeRequestRow } from './row';

const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  street: 'Straße',
  postalCode: 'PLZ',
  city: 'Ort',
  countryIso: 'Land',
  vatId: 'USt-ID',
  invoiceEmail: 'Rechnungs-Mail',
};

export default async function ClientChangeRequestsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  const { id: clientId } = await params;
  const { tenantId, staffId } = session.user;

  const result = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const client = await tx.client.findUnique({
        where: { id: clientId },
        select: {
          id: true, name: true, street: true, postalCode: true,
          city: true, countryIso: true, vatId: true, invoiceEmail: true,
        },
      });
      if (!client) return null;
      const requests = await tx.clientMasterChangeRequest.findMany({
        where: { clientId },
        orderBy: { createdAt: 'desc' },
        include: {
          contact: { select: { fullName: true, email: true } },
        },
        take: 50,
      });
      return { client, requests };
    },
  );
  if (!result) notFound();
  const { client, requests } = result;

  return (
    <div className="p-8 max-w-4xl">
      <Link
        href={`/staff/clients/${client.id}`}
        className="back-link mb-3"
      >
        <ArrowLeft className="h-3 w-3" />
        Mandant
      </Link>
      <h1 className="text-2xl font-bold text-primary mb-1">
        Stammdaten-Änderungen
      </h1>
      <p className="text-muted text-sm mb-6">{client.name}</p>

      {requests.length === 0 ? (
        <div className="card p-8 text-center text-sm text-muted">
          Keine Änderungsanfragen vorhanden.
        </div>
      ) : (
        <ul className="space-y-3">
          {requests.map((r) => {
            const fields = (r.fields ?? {}) as Record<string, string>;
            const current = client as unknown as Record<string, string | null>;
            const rows = Object.entries(fields).map(([k, newVal]) => ({
              key: k,
              label: FIELD_LABELS[k] ?? k,
              before: current[k] ?? '',
              after: newVal,
            }));
            return (
              <li key={r.id} className="card p-4">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <StatusBadge status={r.status} />
                      <span className="text-xs text-muted">
                        {new Intl.DateTimeFormat('de-DE', {
                          dateStyle: 'short',
                          timeStyle: 'short',
                        }).format(r.createdAt)}
                      </span>
                    </div>
                    <p className="text-sm text-secondary">
                      {r.contact.fullName}{' '}
                      <span className="text-xs text-disabled">({r.contact.email})</span>
                    </p>
                    {r.note && (
                      <p className="text-xs text-secondary italic mt-1">„{r.note}"</p>
                    )}
                  </div>
                </div>

                <table className="w-full text-sm border-t border-subtle">
                  <thead>
                    <tr className="text-xs text-muted">
                      <th className="text-left py-1 font-normal">Feld</th>
                      <th className="text-left py-1 font-normal">Bisher</th>
                      <th className="text-left py-1 font-normal">Neu</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.key} className="border-t border-gray-50">
                        <td className="py-1 text-secondary">{row.label}</td>
                        <td className="py-1 text-disabled">{row.before || '—'}</td>
                        <td className="py-1 font-medium text-primary">{row.after}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {r.status === 'PENDING' && (
                  <ChangeRequestRow requestId={r.id} clientId={client.id} />
                )}
                {r.status !== 'PENDING' && r.decisionNote && (
                  <p className="text-xs text-secondary italic mt-3 border-t pt-2 border-subtle">
                    Entscheidung: „{r.decisionNote}"
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'PENDING') {
    return (
      <span className="inline-flex items-center gap-1 badge-yellow">
        <Clock className="h-3 w-3" /> In Prüfung
      </span>
    );
  }
  if (status === 'APPROVED') {
    return (
      <span className="inline-flex items-center gap-1 text-emerald-700 text-xs font-medium">
        <CheckCircle2 className="h-3 w-3" /> Genehmigt
      </span>
    );
  }
  if (status === 'REJECTED') {
    return (
      <span className="inline-flex items-center gap-1 text-red-700 text-xs font-medium">
        <XCircle className="h-3 w-3" /> Abgelehnt
      </span>
    );
  }
  return <span className="text-xs text-muted">{status}</span>;
}
