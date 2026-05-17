// =============================================================================
// /staff/reports — Auswertungs-Dashboard
//
// Zeigt aggregierte KPIs über Anforderungen, Zeit, Rechnungen, Mandanten.
// Alle Werte werden bei jedem Aufruf frisch berechnet (Server Component).
// =============================================================================

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Inbox, Clock, Receipt, TrendingUp, AlertCircle } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import type { Prisma } from '@prisma/client';

async function loadReports(tx: Prisma.TransactionClient) {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfYear = new Date(now.getFullYear(), 0, 1);

  // Anforderungs-KPIs
  const [
    requestStatusCounts,
    overdueRequests,
    requestsLast30,
    avgResponseTime,
    timeEntriesMonth,
    invoiceStatusSums,
    invoicesYTD,
    paidInvoicesAvgPaymentDays,
    topClientsByHours,
    topClientsByRevenue,
  ] = await Promise.all([
    // Status-Verteilung Requests
    tx.request.groupBy({
      by: ['status'],
      _count: { _all: true },
    }),
    // Überfällige offene Requests
    tx.request.count({
      where: {
        status: { in: ['OPEN', 'IN_PROGRESS'] },
        dueAt: { not: null, lt: now },
      },
    }),
    tx.request.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
    // Avg-Response-Time: für RESPONDED + CLOSED requests, Zeit zwischen createdAt
    // und der ersten CLIENT_CONTACT-Antwort.
    tx.$queryRaw<Array<{ avg_seconds: number | null }>>`
      SELECT AVG(EXTRACT(EPOCH FROM (first_response.created_at - r.created_at)))::float AS avg_seconds
      FROM request r
      JOIN LATERAL (
        SELECT created_at FROM request_response
        WHERE request_id = r.id AND author_type = 'CLIENT_CONTACT'
        ORDER BY created_at ASC LIMIT 1
      ) AS first_response ON true
      WHERE r.tenant_id = app.current_tenant_id()
        AND r.created_at >= ${ninetyDaysAgo}
    `,

    tx.timeEntry.aggregate({
      where: { startedAt: { gte: startOfMonth } },
      _count: { _all: true },
    }),

    // Rechnungs-KPIs
    tx.invoice.groupBy({
      by: ['status'],
      _sum: { totalAmount: true },
      _count: { _all: true },
    }),
    tx.invoice.aggregate({
      where: { issueDate: { gte: startOfYear }, status: { not: 'CANCELLED' } },
      _sum: { totalAmount: true, netAmount: true },
      _count: { _all: true },
    }),
    // Avg-Payment-Days
    tx.$queryRaw<Array<{ avg_days: number | null }>>`
      SELECT AVG(EXTRACT(EPOCH FROM (paid_at - issue_date::timestamp)) / 86400)::float AS avg_days
      FROM invoice
      WHERE tenant_id = app.current_tenant_id()
        AND status = 'PAID'
        AND paid_at IS NOT NULL
        AND issue_date >= ${ninetyDaysAgo}
    `,

    // Top-Mandanten nach Stunden (90 Tage)
    tx.$queryRaw<Array<{ client_id: string; name: string; minutes: number }>>`
      SELECT
        c.id::text AS client_id,
        c.name,
        COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(t.ended_at, NOW()) - t.started_at))/60), 0)::int AS minutes
      FROM client c
      JOIN time_entry t ON t.client_id = c.id
      WHERE c.tenant_id = app.current_tenant_id()
        AND t.started_at >= ${ninetyDaysAgo}
        AND t.billable
      GROUP BY c.id, c.name
      ORDER BY minutes DESC
      LIMIT 5
    `,

    // Top-Mandanten nach Umsatz (YTD)
    tx.$queryRaw<Array<{ client_id: string; name: string; revenue: number }>>`
      SELECT
        c.id::text AS client_id,
        c.name,
        SUM(i.net_amount)::float AS revenue
      FROM client c
      JOIN invoice i ON i.client_id = c.id
      WHERE c.tenant_id = app.current_tenant_id()
        AND i.issue_date >= ${startOfYear}
        AND i.status <> 'CANCELLED'
      GROUP BY c.id, c.name
      ORDER BY revenue DESC
      LIMIT 5
    `,
  ]);

  return {
    requestStatusCounts,
    overdueRequests,
    requestsLast30,
    avgResponseTime: avgResponseTime[0]?.avg_seconds ?? null,
    timeEntriesMonth: timeEntriesMonth._count._all,
    invoiceStatusSums,
    invoicesYTD,
    paidInvoicesAvgPaymentDays: paidInvoicesAvgPaymentDays[0]?.avg_days ?? null,
    topClientsByHours,
    topClientsByRevenue,
  };
}

export default async function ReportsPage() {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');

  const { tenantId, staffId } = session.user;
  const data = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    loadReports,
  );

  const fmtEUR = (n: number | null) =>
    n === null
      ? '—'
      : new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);
  const fmtMin = (m: number) => {
    const h = Math.floor(m / 60);
    const mm = Math.round(m % 60);
    return h > 0 ? `${h}h ${mm}m` : `${mm}m`;
  };
  const fmtDuration = (sec: number | null) => {
    if (sec === null) return '—';
    const days = sec / 86400;
    if (days < 1) return `${(sec / 3600).toFixed(1)} h`;
    return `${days.toFixed(1)} Tage`;
  };

  // Ableitungen
  const requestStatusMap = new Map(data.requestStatusCounts.map((r) => [r.status, r._count._all]));
  const totalRequests = Array.from(requestStatusMap.values()).reduce((s, n) => s + n, 0);
  const responded = (requestStatusMap.get('RESPONDED') ?? 0) + (requestStatusMap.get('CLOSED') ?? 0);
  const responseRate = totalRequests > 0 ? (responded / totalRequests) * 100 : 0;

  const invoiceMap = new Map(data.invoiceStatusSums.map((i) => [i.status, i]));
  const openInvoiceTotal = Number(invoiceMap.get('SENT')?._sum.totalAmount ?? 0);
  const overdueInvoices = data.invoiceStatusSums.find((i) => i.status === 'OVERDUE');
  const ytdNet = Number(data.invoicesYTD._sum.netAmount ?? 0);

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">Auswertungen</h1>
        <p className="text-gray-500 text-sm">
          Kanzlei-KPIs aus Anforderungen, Zeiterfassung und Rechnungswesen.
        </p>
      </div>

      {/* Top-KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <Kpi
          icon={Inbox}
          label="Antwortrate (90 Tage)"
          value={`${responseRate.toFixed(0)} %`}
          subtitle={`${responded} von ${totalRequests} Anforderungen`}
          accent={responseRate < 60 ? 'yellow' : 'gray'}
        />
        <Kpi
          icon={Clock}
          label="Avg. Antwortzeit"
          value={fmtDuration(data.avgResponseTime)}
          subtitle="Mandant antwortet"
        />
        <Kpi
          icon={Receipt}
          label="Umsatz YTD (netto)"
          value={fmtEUR(ytdNet)}
          subtitle={`${data.invoicesYTD._count._all} Rechnungen`}
        />
        <Kpi
          icon={TrendingUp}
          label="Avg. Zahlungsdauer"
          value={fmtDuration(data.paidInvoicesAvgPaymentDays === null ? null : data.paidInvoicesAvgPaymentDays * 86400)}
          subtitle="Bezahlt-Rechnungen 90 Tage"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
        {/* Anforderungs-Status */}
        <div className="card p-6">
          <h2 className="text-sm font-medium text-gray-900 mb-4">Anforderungs-Status</h2>
          <div className="space-y-2">
            {(['OPEN', 'IN_PROGRESS', 'RESPONDED', 'CLOSED', 'CANCELLED'] as const).map((s) => {
              const count = requestStatusMap.get(s) ?? 0;
              const pct = totalRequests > 0 ? (count / totalRequests) * 100 : 0;
              const labels: Record<string, string> = {
                OPEN: 'Offen',
                IN_PROGRESS: 'In Bearbeitung',
                RESPONDED: 'Beantwortet',
                CLOSED: 'Geschlossen',
                CANCELLED: 'Abgebrochen',
              };
              return (
                <div key={s}>
                  <div className="flex justify-between text-xs text-gray-600 mb-1">
                    <span>{labels[s]}</span>
                    <span className="font-mono">{count}</span>
                  </div>
                  <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
                    <div
                      className={
                        s === 'OPEN' || s === 'IN_PROGRESS'
                          ? 'h-2 bg-yellow-500'
                          : s === 'RESPONDED'
                            ? 'h-2 bg-green-500'
                            : 'h-2 bg-gray-400'
                      }
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          {data.overdueRequests > 0 && (
            <p className="mt-4 text-sm text-yellow-700 flex items-center gap-2">
              <AlertCircle className="h-4 w-4" />
              {data.overdueRequests} überfällige offene Anforderung{data.overdueRequests === 1 ? '' : 'en'}
            </p>
          )}
        </div>

        {/* Top Mandanten nach Stunden */}
        <div className="card p-6">
          <h2 className="text-sm font-medium text-gray-900 mb-4">Top-Mandanten — Stunden (90 Tage)</h2>
          {data.topClientsByHours.length === 0 ? (
            <p className="text-sm text-gray-400">Keine Daten.</p>
          ) : (
            <ul className="space-y-2">
              {data.topClientsByHours.map((c) => (
                <li key={c.client_id} className="flex justify-between text-sm">
                  <Link href={`/staff/clients/${c.client_id}`} className="text-gray-700 hover:underline truncate">
                    {c.name}
                  </Link>
                  <span className="font-mono text-gray-900">{fmtMin(c.minutes)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Top Mandanten nach Umsatz */}
        <div className="card p-6">
          <h2 className="text-sm font-medium text-gray-900 mb-4">Top-Mandanten — Umsatz (YTD)</h2>
          {data.topClientsByRevenue.length === 0 ? (
            <p className="text-sm text-gray-400">Keine Daten.</p>
          ) : (
            <ul className="space-y-2">
              {data.topClientsByRevenue.map((c) => (
                <li key={c.client_id} className="flex justify-between text-sm">
                  <Link href={`/staff/clients/${c.client_id}`} className="text-gray-700 hover:underline truncate">
                    {c.name}
                  </Link>
                  <span className="font-mono text-gray-900">{fmtEUR(c.revenue)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Rechnungs-Übersicht */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="card p-6 lg:col-span-2">
          <h2 className="text-sm font-medium text-gray-900 mb-4">Rechnungen — Status</h2>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-gray-100">
              {(['DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED'] as const).map((s) => {
                const i = invoiceMap.get(s);
                const count = i?._count._all ?? 0;
                const sum = Number(i?._sum.totalAmount ?? 0);
                const labels: Record<string, string> = {
                  DRAFT: 'Entwurf',
                  SENT: 'Versendet',
                  PAID: 'Bezahlt',
                  OVERDUE: 'Überfällig',
                  CANCELLED: 'Storniert',
                };
                return (
                  <tr key={s}>
                    <td className="py-2 text-gray-700">{labels[s]}</td>
                    <td className="py-2 text-right text-gray-500 w-20">{count}</td>
                    <td className="py-2 text-right font-mono w-32">{fmtEUR(sum)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="card p-6">
          <h2 className="text-sm font-medium text-gray-900 mb-4">Forderungen</h2>
          <p className="text-xs text-gray-500 mb-1">Offene Beträge (versendet)</p>
          <p className="text-2xl font-bold text-gray-900 mb-3">{fmtEUR(openInvoiceTotal)}</p>
          {overdueInvoices && (overdueInvoices._count._all ?? 0) > 0 && (
            <p className="text-sm text-red-700 flex items-center gap-2 mt-3">
              <AlertCircle className="h-4 w-4" />
              {overdueInvoices._count._all} überfällig: {fmtEUR(Number(overdueInvoices._sum.totalAmount ?? 0))}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function Kpi({
  icon: Icon,
  label,
  value,
  subtitle,
  accent,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  subtitle?: string;
  accent?: 'yellow' | 'gray';
}) {
  return (
    <div className="card p-5">
      <div className="flex items-center gap-2 mb-2">
        <Icon className={accent === 'yellow' ? 'h-4 w-4 text-yellow-600' : 'h-4 w-4 text-gray-400'} />
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
      </div>
      <p className="text-2xl font-bold text-gray-900">{value}</p>
      {subtitle && <p className="text-xs text-gray-500 mt-1">{subtitle}</p>}
    </div>
  );
}
