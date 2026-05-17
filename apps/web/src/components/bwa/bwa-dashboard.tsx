// =============================================================================
// BwaDashboard — Server-Component, gemeinsam genutzt von Portal- und
// Staff-BWA-Seite. Erwartet als Eingabe bereits geladene Daten + den
// linkPrefix für Plan-Links + einen optionalen „neuer Plan"-Pfad.
//
// Inhalt:
//   1. Liquiditäts-Indikatoren (mit Warnungen)
//   2. Jahres-Hochrechnung — beide Strategien nebeneinander
//   3. Plan ↔ Hochrechnung
//   4. Planungen-Liste + Szenario-Vergleich
//   5. Historische Tabellen (Jahre / Quartale)
// =============================================================================

import Link from 'next/link';
import {
  BarChart3, Plus, TrendingUp, TrendingDown, Minus, AlertCircle, Info,
} from 'lucide-react';
import { computeBwaKpis } from '@/server/bwa/addison-parser';
import { projectCurrentYear, type ProjectionRange, type YearProjection } from '@/server/bwa/projection';
import { computeLiquidity } from '@/server/bwa/liquidity';
import {
  PlanListWithCompare,
  type PlanForCompare,
  type ProjectionSnapshot,
} from '@/app/portal/(protected)/bwa/plan/plan-comparison';
import { PlanVsProjection } from '@/app/portal/(protected)/bwa/plan/plan-vs-projection';

const fmtEUR = (n: number | null) =>
  n === null ? '—' : new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);
const fmtPct = (n: number | null) =>
  n === null ? '—' : `${n.toFixed(1)} %`;
const fmtRange = (r: ProjectionRange | null) => {
  if (!r) return '—';
  return `${fmtEUR(r.low)} – ${fmtEUR(r.high)}`;
};

export interface BwaPeriodInput {
  id: string;
  periodKey: string;
  periodType: 'YEAR' | 'QUARTER' | 'MONTH';
  fromDate: Date;
  toDate: Date;
  positions: Array<{ number: number; amount: { toString(): string } }>;
}

export interface BwaPlanInput {
  id: string;
  name: string;
  year: number;
  status: string;
  updatedAt: Date;
  createdByType: 'STAFF' | 'CLIENT_CONTACT';
  updatedByType: 'STAFF' | 'CLIENT_CONTACT' | null;
  lines: Array<{ axis: string; amount: { toString(): string } }>;
}

export function BwaDashboard({
  periods,
  plans,
  linkPrefix,
  newPlanHref,
  title = 'Auswertungen',
  subtitle,
}: {
  periods: BwaPeriodInput[];
  plans: BwaPlanInput[];
  /** Wohin Plan-Links zeigen — `/portal/bwa/plan` oder `/staff/clients/X/bwa/plans`. */
  linkPrefix: string;
  /** Wenn null: der „Neuen Plan anlegen"-Knopf wird ausgeblendet (z. B. Portal mit deaktivierter Planung). */
  newPlanHref: string | null;
  title?: string;
  subtitle?: string;
}) {
  const periodsForEngine = periods.map((p) => ({
    periodKey: p.periodKey,
    periodType: p.periodType,
    fromDate: p.fromDate,
    toDate: p.toDate,
    positions: p.positions.map((pos) => ({
      number: pos.number,
      amount: Number(pos.amount.toString()),
    })),
  }));

  const projection = projectCurrentYear(periodsForEngine);

  const latest = periodsForEngine[0] ?? null;
  const previous = latest
    ? periodsForEngine.find(
        (p) => p.periodType === latest.periodType && p.periodKey !== latest.periodKey,
      ) ?? null
    : null;
  const liquidity = latest ? computeLiquidity(latest, previous) : null;

  // Plan-Vergleichs-Snapshot bauen
  const projForCompare = projection.linear ?? projection.trend ?? null;
  let projectionSnapshot: ProjectionSnapshot | null = null;
  let planVsActualKpis: {
    revenue: number | null;
    costs: number | null;
    personnelCost: number | null;
    resultBeforeTax: number | null;
    taxes: number | null;
    resultAfterTax: number | null;
  } | null = null;
  if (projForCompare) {
    const ytdPeriod = periodsForEngine
      .filter((p) => p.fromDate.getUTCFullYear() === projection.targetYear)
      .sort((a, b) => b.toDate.getTime() - a.toDate.getTime())
      .find((p) => {
        const m =
          (p.toDate.getUTCFullYear() - p.fromDate.getUTCFullYear()) * 12 +
          (p.toDate.getUTCMonth() - p.fromDate.getUTCMonth()) + 1;
        return m < 12;
      });
    const ytdMonths = ytdPeriod
      ? (ytdPeriod.toDate.getUTCFullYear() - ytdPeriod.fromDate.getUTCFullYear()) * 12 +
        (ytdPeriod.toDate.getUTCMonth() - ytdPeriod.fromDate.getUTCMonth()) + 1
      : 12;
    const factor = ytdPeriod ? 12 / ytdMonths : 1;

    function posInYtd(num: number): number | null {
      if (!ytdPeriod) return null;
      const p = ytdPeriod.positions.find((x) => x.number === num);
      return p ? p.amount * factor : null;
    }

    const material = posInYtd(3010);
    const depreciation = posInYtd(3100);
    const personnel = projForCompare.personnelCost?.estimate ?? posInYtd(3030) ?? null;
    const totalCosts = projForCompare.costs?.estimate ?? null;
    const otherCosts =
      totalCosts !== null
        ? totalCosts - (personnel ?? 0) - (material ?? 0) - (depreciation ?? 0)
        : null;
    const revenue = projForCompare.revenue?.estimate ?? null;
    const taxes = projForCompare.taxes?.estimate ?? null;
    const resultBeforeTax = projForCompare.result?.estimate ?? null;
    const resultAfterTax = projForCompare.resultAfterTax?.estimate ?? null;

    projectionSnapshot = {
      year: projection.targetYear,
      revenue,
      otherIncome: 0,
      personnelCost: personnel,
      material,
      depreciation,
      otherCosts,
      taxes,
      basis: projForCompare.basis,
    };
    planVsActualKpis = {
      revenue,
      costs: totalCosts,
      personnelCost: personnel,
      resultBeforeTax,
      taxes,
      resultAfterTax,
    };
  }

  const yearPeriods = periods.filter((p) => p.periodType === 'YEAR');
  const quarterPeriods = periods.filter((p) => p.periodType === 'QUARTER');

  const plansForUI: PlanForCompare[] = plans.map((p) => ({
    id: p.id,
    name: p.name,
    year: p.year,
    status: p.status,
    updatedAt: p.updatedAt,
    createdByType: p.createdByType,
    updatedByType: p.updatedByType,
    lines: p.lines.map((l) => ({ axis: l.axis, amount: Number(l.amount.toString()) })),
  }));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 mb-1">{title}</h1>
        {subtitle && <p className="text-gray-500 text-sm">{subtitle}</p>}
      </div>

      {periods.length === 0 ? (
        <div className="card p-16 text-center">
          <BarChart3 className="h-12 w-12 text-gray-200 mx-auto mb-3" />
          <p className="text-sm text-gray-400">Noch keine Auswertungen verfügbar.</p>
        </div>
      ) : (
        <>
          {liquidity && (
            <section>
              <h2 className="text-lg font-semibold text-gray-900 mb-1 flex items-center gap-2">
                Liquiditäts-Indikatoren
                <span className="text-xs text-gray-400 font-normal">· Basis: {latest!.periodKey}</span>
              </h2>
              <p className="text-xs text-gray-500 mb-3">
                Aus PNL-Werten abgeleitete Indikatoren — keine Bilanz-Kennzahlen. Sie ersetzen keine fachliche Liquiditätsplanung.
              </p>
              {liquidity.warning && (
                <div className="card p-4 mb-3 border-amber-200 bg-amber-50/40">
                  <p className="text-sm text-amber-900 flex items-start gap-2">
                    <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                    {liquidity.warning}
                  </p>
                </div>
              )}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <KpiBox
                  label="Operativer Cashflow (Proxy)"
                  value={fmtEUR(liquidity.cashflowProxy)}
                  hint={`Ergebnis + Abschreibungen · ${liquidity.monthsCovered}/12 Monate`}
                  accent={liquidity.cashflowProxy !== null && liquidity.cashflowProxy < 0 ? 'negative' : undefined}
                />
                <KpiBox
                  label="Cashflow / Monat"
                  value={fmtEUR(liquidity.cashflowMonthly)}
                  accent={liquidity.cashflowMonthly !== null && liquidity.cashflowMonthly < 0 ? 'negative' : undefined}
                />
                <KpiBox label="Marge" value={fmtPct(liquidity.marginPct)} trend={liquidity.marginTrend} />
                <KpiBox label="Personalkostenquote" value={fmtPct(liquidity.personnelRatioPct)} trend={liquidity.personnelTrend} trendInvert />
              </div>
            </section>
          )}

          {(projection.linear || projection.trend) && (
            <section>
              <h2 className="text-lg font-semibold text-gray-900 mb-1">
                Jahres-Hochrechnung {projection.targetYear}
              </h2>
              <p className="text-xs text-gray-500 mb-3 flex items-start gap-2">
                <Info className="h-3.5 w-3.5 mt-0.5 shrink-0 text-brand-600" />
                Zwei Modelle nebeneinander, jeweils mit Spannweite — eine BWA ist <strong>kein Abschluss</strong>.
              </p>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <ProjectionCard p={projection.linear} title="Linear + Saisonalität" />
                <ProjectionCard p={projection.trend} title="Trend aus Vorjahren" />
              </div>
            </section>
          )}

          {planVsActualKpis && plansForUI.length > 0 && (
            <PlanVsProjection
              plans={plansForUI}
              projection={planVsActualKpis}
              projectionLabel={projForCompare?.basis ?? ''}
              linkPrefix={linkPrefix}
            />
          )}

          <section>
            <div className="flex items-center justify-between mb-3">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Planrechnung</h2>
                <p className="text-xs text-gray-500">
                  Beliebig viele Versionen pro Jahr. Plan-Spalten lassen sich vergleichen und chronologisch ordnen.
                </p>
              </div>
              {newPlanHref && (
                <Link href={newPlanHref} className="btn-primary">
                  <Plus className="h-4 w-4" />
                  Neue Planung
                </Link>
              )}
            </div>
            <PlanListWithCompare
              plans={plansForUI}
              projection={projectionSnapshot}
              linkPrefix={linkPrefix}
            />
          </section>

          {yearPeriods.length > 0 && (
            <HistorySection title="Jahresübersicht (historisch)" periods={yearPeriods} />
          )}
          {quarterPeriods.length > 0 && (
            <HistorySection title="Quartale (historisch)" periods={quarterPeriods} />
          )}
        </>
      )}
    </div>
  );
}

function KpiBox({
  label,
  value,
  hint,
  accent,
  trend,
  trendInvert,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: 'positive' | 'negative';
  trend?: 'up' | 'down' | 'flat' | null;
  trendInvert?: boolean;
}) {
  let TrendIcon: typeof TrendingUp | null = null;
  let trendCls = 'text-gray-400';
  if (trend === 'up') {
    TrendIcon = TrendingUp;
    trendCls = trendInvert ? 'text-red-600' : 'text-emerald-600';
  } else if (trend === 'down') {
    TrendIcon = TrendingDown;
    trendCls = trendInvert ? 'text-emerald-600' : 'text-red-600';
  } else if (trend === 'flat') {
    TrendIcon = Minus;
  }
  return (
    <div className="card p-4">
      <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">{label}</p>
      <div className="flex items-baseline gap-2">
        <p
          className={
            'text-xl font-bold ' +
            (accent === 'negative' ? 'text-red-700' : accent === 'positive' ? 'text-emerald-700' : 'text-gray-900')
          }
        >
          {value}
        </p>
        {TrendIcon && <TrendIcon className={`h-4 w-4 ${trendCls}`} />}
      </div>
      {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
    </div>
  );
}

function ProjectionCard({ p, title }: { p: YearProjection | null; title: string }) {
  if (!p) {
    return (
      <div className="card p-4 opacity-60">
        <h3 className="text-sm font-medium text-gray-900">{title}</h3>
        <p className="text-xs text-gray-400 mt-2">Nicht genügend Daten für diese Hochrechnung.</p>
      </div>
    );
  }
  return (
    <div className="card p-4">
      <div className="flex items-start justify-between mb-3">
        <h3 className="text-sm font-medium text-gray-900">{title}</h3>
        <span className="text-xs text-gray-400">{p.basis}</span>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-gray-500">
            <th className="text-left py-1 font-normal">KPI</th>
            <th className="text-right py-1 font-normal">Erwartung</th>
            <th className="text-right py-1 font-normal">Spanne</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          <ProjectionRow label="Erlöse" v={p.revenue} />
          <ProjectionRow label="Kosten" v={p.costs} />
          <ProjectionRow label="Personalkosten" v={p.personnelCost} />
          <ProjectionRow label="Ergebnis vor Steuern" v={p.result} accent />
          <ProjectionRow label="Steuern (~30 %)" v={p.taxes} />
          <ProjectionRow label="Ergebnis nach Steuern" v={p.resultAfterTax} accent strong />
        </tbody>
      </table>
      <p className="text-[10px] text-gray-400 mt-2">
        Steuern als Pauschale 25–35 % auf positives Ergebnis vor Steuern.
      </p>
    </div>
  );
}

function ProjectionRow({
  label,
  v,
  accent,
  strong,
}: {
  label: string;
  v: ProjectionRange | null;
  accent?: boolean;
  strong?: boolean;
}) {
  const colorCls =
    accent && v && v.estimate < 0
      ? 'text-red-700'
      : accent && v && v.estimate > 0
      ? 'text-emerald-700'
      : 'text-gray-900';
  const weightCls = strong ? 'font-semibold' : '';
  return (
    <tr className={strong ? 'border-t border-gray-200' : ''}>
      <td className={'py-1.5 text-gray-700 ' + weightCls}>{label}</td>
      <td className={'py-1.5 text-right font-mono tabular-nums ' + colorCls + ' ' + weightCls}>
        {fmtEUR(v?.estimate ?? null)}
      </td>
      <td className="py-1.5 text-right text-xs text-gray-500 font-mono tabular-nums">{fmtRange(v)}</td>
    </tr>
  );
}

function HistorySection({
  title,
  periods,
}: {
  title: string;
  periods: Array<{ id: string; periodKey: string; positions: Array<{ number: number; amount: { toString(): string } }> }>;
}) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-gray-900 mb-3">{title}</h2>
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Periode</th>
              <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Erlöse</th>
              <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Kosten</th>
              <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Ergebnis</th>
              <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Marge</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {periods.slice(0, 8).map((p) => {
              const k = computeBwaKpis(p.positions);
              return (
                <tr key={p.id} className="hover:bg-gray-50">
                  <td className="px-6 py-3 font-medium text-gray-900">{p.periodKey}</td>
                  <td className="px-6 py-3 text-right font-mono tabular-nums">{fmtEUR(k.revenue)}</td>
                  <td className="px-6 py-3 text-right font-mono tabular-nums">{fmtEUR(k.costs)}</td>
                  <td className={`px-6 py-3 text-right font-mono tabular-nums ${k.result !== null && k.result < 0 ? 'text-red-700' : 'text-gray-900'}`}>
                    {fmtEUR(k.result)}
                  </td>
                  <td className="px-6 py-3 text-right font-mono tabular-nums">
                    {k.resultMargin === null ? '—' : `${(k.resultMargin * 100).toFixed(1)} %`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
