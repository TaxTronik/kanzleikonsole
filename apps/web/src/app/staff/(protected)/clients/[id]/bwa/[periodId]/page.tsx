import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { computeBwaKpis } from '@/server/bwa/addison-parser';
import type { LegalForm } from '@/server/bwa/tax-estimator';
import { TaxEstimatorCard } from './tax-estimator-card';

import { fmtDateShort, fmtEUR } from '@/lib/fmt';
export default async function BwaPeriodDetailPage({
  params,
}: {
  params: Promise<{ id: string; periodId: string }>;
}) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');

  const { id: clientId, periodId } = await params;
  const { tenantId, staffId } = session.user;

  const data = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const period = await tx.bwaPeriod.findFirst({
        where: { id: periodId, clientId },
        include: {
          positions: { orderBy: { number: 'asc' } },
          client: { select: { name: true, kind: true } },
        },
      });
      return period;
    },
  );

  if (!data) notFound();
  const period = data;
  const kpis = computeBwaKpis(period.positions);

  const fmtPct = (n: number | null) =>
    n === null ? '—' : `${(n * 100).toFixed(1)} %`;

  return (
    <div className="p-8 max-w-4xl">
      <div className="flex items-start gap-4 mb-6">
        <Link href={`/staff/clients/${clientId}/bwa`} className="text-disabled hover:text-secondary mt-1">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-primary mb-1">{period.periodKey}</h1>
          <p className="text-muted text-sm">
            {period.client.name}
            {' · '}
            {fmtDateShort(period.fromDate)} –{' '}
            {fmtDateShort(period.toDate)}
            {' · '}
            {period.source}
            {period.sourceRef ? ` (${period.sourceRef})` : ''}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
        <KpiCard label="Erlöse" value={fmtEUR(kpis.revenue)} />
        <KpiCard label="Kosten" value={fmtEUR(kpis.costs)} />
        <KpiCard label="Ergebnis" value={fmtEUR(kpis.result)} highlight={kpis.result !== null && kpis.result < 0 ? 'red' : 'green'} />
        <KpiCard label="Marge" value={fmtPct(kpis.resultMargin)} />
        <KpiCard label="Personalkosten" value={fmtEUR(kpis.personnelCost)} />
        <KpiCard label="Personalquote" value={fmtPct(kpis.personnelRatio)} />
      </div>

      {kpis.result !== null && (
        <TaxEstimatorCard
          result={kpis.result}
          resultBeforeTax={kpis.resultBeforeTax}
          revenue={kpis.revenue}
          inputVat={(() => {
            const v = period.positions.find((p) => p.number === 3190);
            return v ? Number(v.amount.toString()) : null;
          })()}
          vatPaid={(() => {
            const v = period.positions.find((p) => p.number === 3200);
            return v ? Number(v.amount.toString()) : null;
          })()}
          defaultLegalForm={
            (period.client.kind === 'JURPERS' ? 'GMBH'
            : period.client.kind === 'PERSGES' ? 'GBR'
            : 'EINZELUNTERNEHMEN') as LegalForm
          }
        />
      )}

      <div className="card overflow-hidden">
        <div className="px-6 py-4 border-b border-default">
          <h2 className="text-sm font-medium text-primary">
            Alle Positionen ({period.positions.length})
          </h2>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-default">
              <th className="th">Nr.</th>
              <th className="th">Bezeichnung</th>
              <th className="th th-right">Betrag</th>
              <th className="th th-right">Anteil</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {period.positions.map((p) => (
              <tr key={p.id} className="hover:bg-gray-50">
                <td className="px-6 py-2 text-muted font-mono">{p.number}</td>
                <td className="px-6 py-2 text-primary">{p.label}</td>
                <td className="px-6 py-2 text-right font-mono tabular-nums">
                  {fmtEUR(Number(p.amount.toString()))}
                </td>
                <td className="px-6 py-2 text-right text-muted font-mono tabular-nums">
                  {p.sharePct === null ? '—' : `${Number(p.sharePct.toString()).toFixed(1)} %`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function KpiCard({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: 'green' | 'red';
}) {
  const valueClass =
    highlight === 'red' ? 'text-red-700' : highlight === 'green' ? 'text-green-700' : 'text-primary';
  return (
    <div className="card p-4">
      <p className="eyebrow">{label}</p>
      <p className={`text-xl font-bold ${valueClass}`}>{value}</p>
    </div>
  );
}
