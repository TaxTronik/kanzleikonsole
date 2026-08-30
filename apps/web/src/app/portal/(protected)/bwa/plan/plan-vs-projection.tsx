'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import type { PlanForCompare } from './plan-comparison';
import { fmtEURRound } from '@/lib/fmt';

interface ProjectedKpis {
  revenue: number | null;
  costs: number | null; // ohne Steuern
  personnelCost: number | null;
  resultBeforeTax: number | null;
  taxes: number | null;
  resultAfterTax: number | null;
}

function plannedTotals(p: PlanForCompare) {
  const get = (axis: string) => p.lines.find((l) => l.axis === axis)?.amount ?? 0;
  const revenue = get('REVENUE') + get('OTHER_INCOME');
  const personnelCost = get('PERSONNEL');
  const costs = get('PERSONNEL') + get('MATERIAL') + get('DEPRECIATION') + get('OTHER_COSTS');
  const taxes = get('TAXES');
  const resultBeforeTax = revenue - costs;
  return {
    revenue,
    costs,
    personnelCost,
    resultBeforeTax,
    taxes,
    resultAfterTax: resultBeforeTax - taxes,
  };
}

export function PlanVsProjection({
  plans,
  projection,
  projectionLabel,
  linkPrefix = '/portal/bwa/plan',
}: {
  plans: PlanForCompare[];
  projection: ProjectedKpis;
  projectionLabel: string;
  linkPrefix?: string;
}) {
  // Default: neuester FINAL-Plan, sonst neuester Plan
  const defaultPlanId = useMemo(() => {
    const finals = plans.filter((p) => p.status === 'FINAL');
    const ordered = (finals.length > 0 ? finals : plans).slice();
    return ordered[0]?.id ?? '';
  }, [plans]);

  const [planId, setPlanId] = useState<string>(defaultPlanId);
  const selectedPlan = plans.find((p) => p.id === planId) ?? null;

  if (plans.length === 0) return null;

  const plan = selectedPlan ? plannedTotals(selectedPlan) : null;

  const rows: Array<{
    label: string;
    plan: number | null;
    actual: number | null;
    accent?: boolean;
    invertDirection?: boolean;
  }> = plan
    ? [
        { label: 'Erlöse', plan: plan.revenue, actual: projection.revenue },
        {
          label: 'Aufwendungen (ohne Steuern)',
          plan: plan.costs,
          actual: projection.costs,
          invertDirection: true,
        },
        {
          label: 'Personalkosten',
          plan: plan.personnelCost,
          actual: projection.personnelCost,
          invertDirection: true,
        },
        {
          label: 'Ergebnis vor Steuern',
          plan: plan.resultBeforeTax,
          actual: projection.resultBeforeTax,
          accent: true,
        },
        { label: 'Steuern', plan: plan.taxes, actual: projection.taxes, invertDirection: true },
        {
          label: 'Ergebnis nach Steuern',
          plan: plan.resultAfterTax,
          actual: projection.resultAfterTax,
          accent: true,
        },
      ]
    : [];

  return (
    <section className="mb-8">
      <div className="flex items-end justify-between gap-3 mb-3">
        <div>
          <h2 className="text-lg font-semibold text-primary">Plan vs. Hochrechnung</h2>
          <p className="text-xs text-muted">
            Wo stehen Sie aktuell gegenüber Ihrer Planung? Basis: {projectionLabel}
          </p>
        </div>
        <div>
          <label className="text-xs text-muted block mb-1" htmlFor="plan-vs-projection-plan">
            Planung
          </label>
          <select
            id="plan-vs-projection-plan"
            value={planId}
            onChange={(e) => setPlanId(e.target.value)}
            className="input text-sm py-1.5"
          >
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.year}
                {p.status === 'FINAL' ? '' : ' (Entwurf)'}
              </option>
            ))}
          </select>
        </div>
      </div>

      {!plan ? (
        <div className="card p-6 text-center text-sm text-disabled">
          Bitte eine Planung auswählen.
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-default">
                <th className="text-left px-4 py-2 text-xs font-medium text-muted uppercase">
                  Position
                </th>
                <th className="text-right px-4 py-2 text-xs font-medium text-muted uppercase">
                  Plan
                </th>
                <th className="text-right px-4 py-2 text-xs font-medium text-muted uppercase">
                  Hochrechnung
                </th>
                <th className="text-right px-4 py-2 text-xs font-medium text-muted uppercase">
                  Δ absolut
                </th>
                <th className="text-right px-4 py-2 text-xs font-medium text-muted uppercase">
                  Δ %
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {rows.map((r) => (
                <Row key={r.label} {...r} />
              ))}
            </tbody>
          </table>
          {selectedPlan && (
            <div className="px-4 py-2 border-t border-default text-xs text-muted">
              <Link
                href={`${linkPrefix}/${selectedPlan.id}`}
                className="text-brand-700 hover:underline"
              >
                Planung „{selectedPlan.name}" bearbeiten →
              </Link>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Row({
  label,
  plan,
  actual,
  accent,
  invertDirection,
}: {
  label: string;
  plan: number | null;
  actual: number | null;
  accent?: boolean;
  invertDirection?: boolean;
}) {
  const delta = plan !== null && actual !== null ? actual - plan : null;
  const deltaPct =
    delta !== null && plan !== null && plan !== 0 ? (delta / Math.abs(plan)) * 100 : null;

  let Trend: typeof TrendingUp | null = null;
  let trendCls = 'text-disabled';
  if (delta !== null) {
    const positive = invertDirection ? delta < 0 : delta > 0;
    if (Math.abs(delta) < 1) {
      Trend = Minus;
    } else if (positive) {
      Trend = TrendingUp;
      trendCls = 'text-emerald-600';
    } else {
      Trend = TrendingDown;
      trendCls = 'text-red-600';
    }
  }

  const valCls = (v: number | null) =>
    'px-4 py-2 text-right font-mono tabular-nums ' +
    (v === null
      ? 'text-disabled'
      : accent && v < 0
        ? 'text-red-700 font-semibold'
        : accent && v > 0
          ? 'text-emerald-700 font-semibold'
          : 'text-primary');

  return (
    <tr>
      <td className="px-4 py-2 text-secondary">{label}</td>
      <td className={valCls(plan)}>{plan === null ? '—' : fmtEURRound(plan)}</td>
      <td className={valCls(actual)}>{actual === null ? '—' : fmtEURRound(actual)}</td>
      <td className="px-4 py-2 text-right font-mono tabular-nums">
        {delta === null ? (
          <span className="text-disabled">—</span>
        ) : (
          <span className="inline-flex items-center gap-1 justify-end">
            {Trend && <Trend className={`h-3.5 w-3.5 ${trendCls}`} />}
            <span className={trendCls + (Trend === Minus ? ' text-muted' : '')}>
              {delta > 0 ? '+' : ''}
              {fmtEURRound(delta)}
            </span>
          </span>
        )}
      </td>
      <td className="px-4 py-2 text-right font-mono tabular-nums text-xs text-muted">
        {deltaPct === null ? '—' : `${deltaPct > 0 ? '+' : ''}${deltaPct.toFixed(1)} %`}
      </td>
    </tr>
  );
}
