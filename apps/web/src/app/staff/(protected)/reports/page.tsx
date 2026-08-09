import type { ComponentType } from 'react';
// =============================================================================
// /staff/reports — Auswertungs-Dashboard
//
// Zeigt aggregierte KPIs über Anforderungen, Zeit, Rechnungen, Mandanten.
// Alle Werte werden bei jedem Aufruf frisch berechnet (Server Component).
// =============================================================================

import Link from 'next/link';
import { Inbox, Clock, Receipt, TrendingUp, AlertCircle } from 'lucide-react';
import { requireStaffPage } from '@/server/auth/staff-page';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';

import { fmtEURRound } from '@/lib/fmt';
import { INVOICE_STATUS_LABELS } from '@/lib/domain-labels';
import { loadReports } from './data';

export default async function ReportsPage() {
  const session = await requireStaffPage();
  const canViewBilling = isStaffAdmin(session);

  const { tenantId, staffId } = session.user;
  const data = await withTenantContext({ tenantId, actorId: staffId, actorType: 'STAFF' }, (tx) =>
    loadReports(tx, canViewBilling),
  );

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
  const responded =
    (requestStatusMap.get('RESPONDED') ?? 0) + (requestStatusMap.get('CLOSED') ?? 0);
  const responseRate = totalRequests > 0 ? (responded / totalRequests) * 100 : 0;

  const billing = data.billing;
  const invoiceMap = new Map(billing?.invoiceStatusSums.map((i) => [i.status, i]) ?? []);
  const openInvoiceTotal = Number(invoiceMap.get('SENT')?._sum.totalAmount ?? 0);
  const overdueInvoices = billing?.invoiceStatusSums.find((i) => i.status === 'OVERDUE');
  const ytdNet = Number(billing?.invoicesYTD._sum.netAmount ?? 0);

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-primary mb-1">Auswertungen</h1>
        <p className="text-muted text-sm">
          {billing
            ? 'Kanzlei-KPIs aus Anforderungen, Zeiterfassung und Rechnungswesen.'
            : 'Kanzlei-KPIs aus Anforderungen und Zeiterfassung.'}
        </p>
      </div>

      {/* Top-KPIs */}
      <div
        className={`grid grid-cols-2 gap-4 mb-8 ${billing ? 'lg:grid-cols-4' : 'lg:grid-cols-2 lg:max-w-3xl'}`}
      >
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
        {billing && (
          <>
            <Kpi
              icon={Receipt}
              label="Umsatz lfd. Jahr (netto)"
              value={fmtEURRound(ytdNet)}
              subtitle={`${billing.invoicesYTD._count._all} Rechnungen`}
            />
            <Kpi
              icon={TrendingUp}
              label="Avg. Zahlungsdauer"
              value={fmtDuration(
                billing.paidInvoicesAvgPaymentDays === null
                  ? null
                  : billing.paidInvoicesAvgPaymentDays * 86400,
              )}
              subtitle="Bezahlt-Rechnungen 90 Tage"
            />
          </>
        )}
      </div>

      <div
        className={`grid grid-cols-1 gap-6 mb-8 ${billing ? 'lg:grid-cols-3' : 'lg:grid-cols-2'}`}
      >
        {/* Anforderungs-Status */}
        <div className="card p-6">
          <h2 className="text-sm font-medium text-primary mb-4">Anforderungs-Status</h2>
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
                  <div className="flex justify-between text-xs text-secondary mb-1">
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
              {data.overdueRequests} überfällige offene Anforderung
              {data.overdueRequests === 1 ? '' : 'en'}
            </p>
          )}
        </div>

        {/* Top Mandanten nach Stunden */}
        <div className="card p-6">
          <h2 className="text-sm font-medium text-primary mb-4">
            Top-Mandanten — Stunden (90 Tage)
          </h2>
          {data.topClientsByHours.length === 0 ? (
            <p className="text-sm text-disabled">Keine Daten.</p>
          ) : (
            <ul className="space-y-2">
              {data.topClientsByHours.map((c) => (
                <li key={c.client_id} className="flex justify-between text-sm">
                  <Link
                    href={`/staff/clients/${c.client_id}`}
                    className="text-secondary hover:underline truncate"
                  >
                    {c.name}
                  </Link>
                  <span className="font-mono text-primary">{fmtMin(c.minutes)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Top Mandanten nach Umsatz */}
        {billing && (
          <div className="card p-6">
            <h2 className="text-sm font-medium text-primary mb-4">
              Top-Mandanten — Umsatz im lfd. Jahr
            </h2>
            {billing.topClientsByRevenue.length === 0 ? (
              <p className="text-sm text-disabled">Keine Daten.</p>
            ) : (
              <ul className="space-y-2">
                {billing.topClientsByRevenue.map((c) => (
                  <li key={c.client_id} className="flex justify-between text-sm">
                    <Link
                      href={`/staff/clients/${c.client_id}`}
                      className="text-secondary hover:underline truncate"
                    >
                      {c.name}
                    </Link>
                    <span className="font-mono text-primary">{fmtEURRound(c.revenue)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Rechnungs-Übersicht */}
      {billing && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="card p-6 lg:col-span-2">
            <h2 className="text-sm font-medium text-primary mb-4">Rechnungen — Status</h2>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-border-subtle">
                {(['DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED'] as const).map((s) => {
                  const i = invoiceMap.get(s);
                  const count = i?._count._all ?? 0;
                  const sum = Number(i?._sum.totalAmount ?? 0);
                  return (
                    <tr key={s}>
                      <td className="py-2 text-secondary">{INVOICE_STATUS_LABELS[s]}</td>
                      <td className="py-2 text-right text-muted w-20">{count}</td>
                      <td className="py-2 text-right font-mono w-32">{fmtEURRound(sum)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="card p-6">
            <h2 className="text-sm font-medium text-primary mb-4">Forderungen</h2>
            <p className="text-xs text-muted mb-1">Offene Beträge (versendet)</p>
            <p className="text-2xl font-bold text-primary mb-3">{fmtEURRound(openInvoiceTotal)}</p>
            {overdueInvoices && (overdueInvoices._count._all ?? 0) > 0 && (
              <p className="text-sm text-red-700 flex items-center gap-2 mt-3">
                <AlertCircle className="h-4 w-4" />
                {overdueInvoices._count._all} überfällig:{' '}
                {fmtEURRound(Number(overdueInvoices._sum.totalAmount ?? 0))}
              </p>
            )}
          </div>
        </div>
      )}
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
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
  subtitle?: string;
  accent?: 'yellow' | 'gray';
}) {
  return (
    <div className="card p-5">
      <div className="flex items-center gap-2 mb-2">
        <Icon
          className={accent === 'yellow' ? 'h-4 w-4 text-yellow-600' : 'h-4 w-4 text-disabled'}
        />
        <p className="text-xs font-medium text-muted uppercase tracking-wide">{label}</p>
      </div>
      <p className="text-2xl font-bold text-primary">{value}</p>
      {subtitle && <p className="text-xs text-muted mt-1">{subtitle}</p>}
    </div>
  );
}
