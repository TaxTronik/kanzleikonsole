import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Clock } from 'lucide-react';
import { requireStaffPage } from '@/server/auth/staff-page';
import { hasStaffPermission } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { BillingForm } from './billing-form';
import { fmtDateShort } from '@/lib/fmt';

export default async function ClientBillingPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireStaffPage();

  const { id: clientId } = await params;
  const { tenantId, staffId } = session.user;

  const data = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const client = await tx.client.findUnique({ where: { id: clientId } });
      if (!client) return null;

      const pendingEntries = await tx.timeEntry.findMany({
        where: {
          clientId,
          billable: true,
          invoiceId: null,
          endedAt: { not: null },
        },
        orderBy: { startedAt: 'asc' },
        include: { staff: { select: { fullName: true } } },
      });

      return { client, pendingEntries };
    },
  );

  if (!data) notFound();
  const { client, pendingEntries } = data;

  const totalMinutes = pendingEntries.reduce((s, e) => {
    if (!e.endedAt) return s;
    return s + Math.max(0, Math.floor((e.endedAt.getTime() - e.startedAt.getTime()) / 60_000));
  }, 0);
  const totalHours = totalMinutes / 60;

  // iter85 (GoB): Rechnungsnummer vergibt der Nummernkreis automatisch und
  // lückenlos beim Anlegen — kein clientseitiger Vorschlag mehr.

  const fmtMin = (m: number) => {
    const h = Math.floor(m / 60);
    const mm = Math.round(m % 60);
    return h > 0 ? `${h}h ${mm}m` : `${mm}m`;
  };

  return (
    <div className="p-8 max-w-4xl">
      <div className="flex items-start gap-4 mb-6">
        <Link
          href={`/staff/clients/${client.id}`}
          className="text-disabled hover:text-secondary mt-1"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-primary mb-1">Stunden abrechnen</h1>
          <p className="text-muted text-sm">{client.name}</p>
        </div>
      </div>

      {!client.allowActive && (
        <div className="rounded-md bg-yellow-50 p-4 text-sm text-yellow-800 mb-4">
          Mandant ist nicht aktiv. GwG-Prüfung muss zuerst abgeschlossen sein.
        </div>
      )}

      <div className="grid grid-cols-3 gap-4 mb-6">
        <Kpi label="Offene Stunden" value={fmtMin(totalMinutes)} />
        <Kpi label="Anzahl Einträge" value={String(pendingEntries.length)} />
        <Kpi label="Stunden total" value={totalHours.toFixed(2)} />
      </div>

      {pendingEntries.length === 0 ? (
        <div className="card p-12 text-center">
          <Clock className="h-12 w-12 text-disabled mx-auto mb-3" />
          <p className="text-sm text-disabled">Keine abrechenbaren, unabgerechneten Stunden.</p>
        </div>
      ) : (
        <>
          {/* Tabelle der offenen Einträge */}
          <div className="card overflow-hidden mb-6">
            <div className="px-6 py-3 border-b border-default text-xs text-muted">
              {pendingEntries.length} Einträge — werden alle in die Rechnung übernommen
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-default">
                  <th className="text-left px-6 py-2 text-xs font-medium text-muted uppercase tracking-wide">
                    Datum
                  </th>
                  <th className="text-left px-6 py-2 text-xs font-medium text-muted uppercase tracking-wide">
                    Beschreibung
                  </th>
                  <th className="text-left px-6 py-2 text-xs font-medium text-muted uppercase tracking-wide">
                    Mitarbeiter
                  </th>
                  <th className="text-right px-6 py-2 text-xs font-medium text-muted uppercase tracking-wide">
                    Stunden
                  </th>
                  <th className="text-right px-6 py-2 text-xs font-medium text-muted uppercase tracking-wide">
                    Stundensatz
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {pendingEntries.map((e) => {
                  const minutes = e.endedAt
                    ? Math.max(
                        0,
                        Math.floor((e.endedAt.getTime() - e.startedAt.getTime()) / 60_000),
                      )
                    : 0;
                  const hours = minutes / 60;
                  return (
                    <tr key={e.id} className="hover:bg-gray-50">
                      <td className="px-6 py-2 text-secondary whitespace-nowrap">
                        {fmtDateShort(e.startedAt)}
                      </td>
                      <td className="px-6 py-2 text-primary truncate max-w-md">{e.description}</td>
                      <td className="px-6 py-2 text-secondary">{e.staff.fullName}</td>
                      <td className="px-6 py-2 text-right font-mono tabular-nums">
                        {hours.toFixed(2)}
                      </td>
                      <td className="px-6 py-2 text-right font-mono tabular-nums text-muted">
                        {e.hourlyRate
                          ? `${Number(e.hourlyRate.toString()).toFixed(2)} €`
                          : 'Default'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Form zur Rechnungs-Erstellung — nur mit Einzelrecht (iter87) */}
          {client.allowActive && hasStaffPermission(session, 'INVOICE_MANAGE') && (
            <div className="card p-6">
              <h2 className="text-sm font-medium text-primary mb-3">Rechnung erstellen</h2>
              <BillingForm clientId={client.id} totalHours={totalHours} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-4">
      <p className="eyebrow">{label}</p>
      <p className="text-2xl font-bold text-primary">{value}</p>
    </div>
  );
}
