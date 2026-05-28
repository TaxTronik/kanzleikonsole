import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, BarChart3, Trash2 } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { computeBwaKpis } from '@/server/bwa/addison-parser';
import { BwaImportForm } from './import-form';
import { deleteBwaPeriodAction } from './actions';

import { fmtEURRound } from '@/lib/fmt';
export default async function ClientBwaPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');

  const { id: clientId } = await params;
  const { tenantId, staffId } = session.user;

  const data = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const client = await tx.client.findUnique({ where: { id: clientId } });
      if (!client) return null;
      const [periods, plans] = await Promise.all([
        tx.bwaPeriod.findMany({
          where: { clientId },
          orderBy: [{ periodType: 'asc' }, { fromDate: 'desc' }],
          include: { positions: true },
        }),
        tx.bwaPlan.findMany({
          where: { clientId },
          orderBy: [{ year: 'desc' }, { updatedAt: 'desc' }],
          select: { id: true, name: true, year: true, status: true, updatedAt: true, createdByType: true },
        }),
      ]);
      return { client, periods, plans };
    },
  );

  if (!data) notFound();
  const { client, periods, plans } = data;

  const yearPeriods = periods.filter((p) => p.periodType === 'YEAR');
  const quarterPeriods = periods.filter((p) => p.periodType === 'QUARTER');

  return (
    <div className="p-8 max-w-5xl">
      <div className="flex items-start gap-4 mb-6">
        <Link href={`/staff/clients/${client.id}`} className="text-disabled hover:text-secondary mt-1">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-primary mb-1">BWA & Auswertungen</h1>
          <p className="text-muted text-sm">{client.name}</p>
        </div>
        <Link href={`/staff/clients/${client.id}/bwa/plans`} className="btn-primary text-xs py-1.5">
          Auswertung wie Mandant
        </Link>
      </div>

      <div className="card p-6 mb-6">
        <h2 className="text-sm font-medium text-primary mb-3">Import</h2>
        <p className="text-xs text-muted mb-4">
          Unterstützt Addison-CSV und DATEV-XLSX-Vorjahresvergleich.
          Existierende Perioden (gleicher Schlüssel) werden übersprungen.
        </p>
        <BwaImportForm clientId={client.id} />
      </div>

      {periods.length === 0 ? (
        <div className="card p-16 text-center">
          <BarChart3 className="h-12 w-12 text-disabled mx-auto mb-3" />
          <p className="text-sm text-disabled">
            Noch keine BWA-Daten. Importieren Sie eine Addison-CSV oben.
          </p>
        </div>
      ) : (
        <>
          {yearPeriods.length > 0 && (
            <section className="mb-6">
              <h2 className="text-lg font-semibold text-primary mb-3">Jahresübersicht</h2>
              <div className="card overflow-hidden">
                <PeriodComparisonTable periods={yearPeriods} />
              </div>
            </section>
          )}

          {quarterPeriods.length > 0 && (
            <section className="mb-6">
              <h2 className="text-lg font-semibold text-primary mb-3">Quartale</h2>
              <div className="card overflow-hidden">
                <PeriodComparisonTable periods={quarterPeriods} />
              </div>
            </section>
          )}

          {plans.length > 0 && (
            <section className="mb-6">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-lg font-semibold text-primary">Planungen</h2>
                <Link
                  href={`/staff/clients/${client.id}/bwa/plans`}
                  className="text-xs text-brand-700 hover:underline"
                >
                  Vollständige Auswertung →
                </Link>
              </div>
              <div className="card overflow-hidden">
                <ul className="divide-y divide-border-subtle">
                  {plans.map((p) => (
                    <li key={p.id} className="px-6 py-3 flex items-center justify-between">
                      <Link
                        href={`/staff/clients/${client.id}/bwa/plans/${p.id}`}
                        className="flex-1 hover:underline"
                      >
                        <p className="text-sm font-medium text-primary">
                          {p.name} <span className="text-xs text-muted font-normal">· {p.year}</span>
                        </p>
                        <p className="text-xs text-muted">
                          {p.createdByType === 'CLIENT_CONTACT' ? 'vom Mandant' : 'von der Kanzlei'} · zuletzt geändert {new Intl.DateTimeFormat('de-DE').format(p.updatedAt)}
                        </p>
                      </Link>
                      {p.status === 'FINAL' ? (
                        <span className="badge-green">Final</span>
                      ) : (
                        <span className="badge-yellow">Entwurf</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          <section>
            <h2 className="text-lg font-semibold text-primary mb-3">Alle Perioden</h2>
            <div className="card overflow-hidden">
              <ul className="divide-y divide-border-subtle">
                {periods.map((p) => (
                  <li key={p.id} className="px-6 py-3 flex items-center justify-between">
                    <Link
                      href={`/staff/clients/${client.id}/bwa/${p.id}`}
                      className="flex-1 hover:underline"
                    >
                      <span className="font-medium text-primary">{p.periodKey}</span>
                      <span className="text-xs text-muted ml-3">
                        {p.positions.length} Positionen · {p.source}
                        {p.sourceRef ? ` (${p.sourceRef})` : ''}
                      </span>
                    </Link>
                    <form action={deleteBwaPeriodAction}>
                      <input type="hidden" name="periodId" value={p.id} />
                      <input type="hidden" name="clientId" value={client.id} />
                      <button
                        type="submit"
                        className="text-disabled hover:text-red-600 p-2"
                        title="Löschen"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function PeriodComparisonTable({
  periods,
}: {
  periods: Array<{ id: string; periodKey: string; positions: Array<{ number: number; amount: { toString(): string } }> }>;
}) {
  const rows = periods.slice(0, 4).map((p) => ({
    id: p.id,
    label: p.periodKey,
    kpis: computeBwaKpis(p.positions),
  }));


  const fmtPct = (n: number | null) =>
    n === null ? '—' : `${(n * 100).toFixed(1)} %`;

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="bg-gray-50 border-b border-default">
          <th className="th">Periode</th>
          <th className="th th-right">Erlöse</th>
          <th className="th th-right">Kosten</th>
          <th className="th th-right">Ergebnis</th>
          <th className="th th-right">Marge</th>
          <th className="th th-right">Personalquote</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border-subtle">
        {rows.map((r) => (
          <tr key={r.id} className="hover:bg-gray-50">
            <td className="px-6 py-3 font-medium text-primary">{r.label}</td>
            <td className="td-num">{fmtEURRound(r.kpis.revenue)}</td>
            <td className="td-num">{fmtEURRound(r.kpis.costs)}</td>
            <td className="td-num">{fmtEURRound(r.kpis.result)}</td>
            <td className="td-num">{fmtPct(r.kpis.resultMargin)}</td>
            <td className="td-num">{fmtPct(r.kpis.personnelRatio)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
