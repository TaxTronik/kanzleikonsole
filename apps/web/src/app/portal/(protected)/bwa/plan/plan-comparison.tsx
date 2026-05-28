'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';

type Axis =
  | 'REVENUE' | 'PERSONNEL' | 'OTHER_COSTS' | 'DEPRECIATION' | 'MATERIAL' | 'OTHER_INCOME' | 'TAXES';

const AXIS_LABELS: Record<Axis, string> = {
  REVENUE: 'Erlöse',
  OTHER_INCOME: 'Sonstige Erträge',
  PERSONNEL: 'Personalkosten',
  MATERIAL: 'Material',
  DEPRECIATION: 'Abschreibungen',
  OTHER_COSTS: 'Sonstige Kosten',
  TAXES: 'Steuern',
};
const ORDER: Axis[] = ['REVENUE', 'OTHER_INCOME', 'PERSONNEL', 'MATERIAL', 'DEPRECIATION', 'OTHER_COSTS', 'TAXES'];

const eurFmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const dateFmt = new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short' });

export interface PlanForCompare {
  id: string;
  name: string;
  year: number;
  status: string;
  updatedAt: Date;
  createdByType?: 'STAFF' | 'CLIENT_CONTACT';
  updatedByType?: 'STAFF' | 'CLIENT_CONTACT' | null;
  lines: Array<{ axis: string; amount: number }>;
}

function lineValue(plan: PlanForCompare, axis: Axis): number {
  const l = plan.lines.find((x) => x.axis === axis);
  return l ? l.amount : 0;
}

function totals(plan: PlanForCompare) {
  const revenue = lineValue(plan, 'REVENUE') + lineValue(plan, 'OTHER_INCOME');
  const costs =
    lineValue(plan, 'PERSONNEL') +
    lineValue(plan, 'MATERIAL') +
    lineValue(plan, 'DEPRECIATION') +
    lineValue(plan, 'OTHER_COSTS');
  const taxes = lineValue(plan, 'TAXES');
  const resultBeforeTax = revenue - costs;
  const resultAfterTax = resultBeforeTax - taxes;
  return { revenue, costs, resultBeforeTax, taxes, resultAfterTax };
}

export interface ProjectionSnapshot {
  year: number;
  revenue: number | null;
  otherIncome: number | null;
  personnelCost: number | null;
  material: number | null;
  depreciation: number | null;
  otherCosts: number | null;
  taxes: number | null;
  // Optional: Basis-Beschreibung („YTD 2026-Q2", „Trend aus 4 Jahren")
  basis: string;
}

export function PlanListWithCompare({
  plans,
  projection,
  linkPrefix = '/portal/bwa/plan',
}: {
  plans: PlanForCompare[];
  projection: ProjectionSnapshot | null;
  /** Wohin die Plan-Links zeigen — `/portal/bwa/plan` oder `/staff/clients/X/bwa/plans`. */
  linkPrefix?: string;
}) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [includeProjection, setIncludeProjection] = useState(true);

  // Mehrjahres-Sicht: nach Jahr aufsteigend, dann nach Name. Dadurch sind
  // bei mehreren Jahren die Spalten chronologisch geordnet.
  const selected = useMemo(
    () =>
      plans
        .filter((p) => selectedIds.includes(p.id))
        .sort((a, b) => a.year - b.year || a.name.localeCompare(b.name)),
    [plans, selectedIds],
  );

  function toggle(id: string) {
    setSelectedIds((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  if (plans.length === 0) {
    return (
      <div className="card p-8 text-center text-sm text-disabled">
        Noch keine eigene Planung erstellt.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="card overflow-hidden">
        <div className="px-5 py-2 border-b border-default bg-gray-50 text-xs text-muted flex items-center justify-between">
          <span>
            {plans.length} Planung{plans.length === 1 ? '' : 'en'}
            {selectedIds.length > 0 && ` · ${selectedIds.length} zum Vergleichen ausgewählt`}
          </span>
          {selectedIds.length > 0 && (
            <button
              type="button"
              onClick={() => setSelectedIds([])}
              className="text-brand-700 hover:underline"
            >
              Auswahl löschen
            </button>
          )}
        </div>
        <ul className="divide-y divide-border-subtle">
          {plans.map((p) => (
            <li key={p.id} className="flex items-center gap-3 px-5 py-3">
              <input
                type="checkbox"
                checked={selectedIds.includes(p.id)}
                onChange={() => toggle(p.id)}
                className="rounded border-strong text-brand-600 shrink-0"
                aria-label={`${p.name} zum Vergleich auswählen`}
              />
              <Link
                href={`${linkPrefix}/${p.id}`}
                className="flex-1 flex items-center justify-between gap-3 rounded-md px-2 py-1 -mx-2 hover:bg-gray-50"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-primary flex items-center gap-2 flex-wrap">
                    <span>{p.name}</span>
                    <span className="text-xs text-muted font-normal">· {p.year}</span>
                    <ActorBadge createdByType={p.createdByType} updatedByType={p.updatedByType} />
                  </p>
                  <p className="text-xs text-muted">
                    Erg. nach Steuern: {eurFmt.format(totals(p).resultAfterTax)} ·
                    zuletzt geändert {dateFmt.format(p.updatedAt)}
                  </p>
                </div>
                {p.status === 'FINAL' ? (
                  <span className="badge-green">Final</span>
                ) : (
                  <span className="badge-yellow">Entwurf</span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      </div>

      {selected.length >= 1 && (
        <>
          {selected.length === 1 && !projection && (
            <p className="text-xs text-muted text-center">
              Wählen Sie mindestens eine weitere Planung zum Vergleichen.
            </p>
          )}
          {(selected.length >= 2 || (selected.length === 1 && projection)) && (
            <>
              {projection && (
                <label className="flex items-center gap-2 text-xs text-secondary">
                  <input
                    type="checkbox"
                    checked={includeProjection}
                    onChange={(e) => setIncludeProjection(e.target.checked)}
                    className="rounded border-strong text-brand-600"
                  />
                  Hochrechnung {projection.year} als zusätzliche Spalte
                </label>
              )}
              <ComparisonTable
                plans={selected}
                projection={includeProjection ? projection : null}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}

function ComparisonTable({
  plans,
  projection,
}: {
  plans: PlanForCompare[];
  projection: ProjectionSnapshot | null;
}) {
  const sums = plans.map(totals);

  // Hochrechnung als Pseudo-Spalte aufbereiten — chronologisch einsortiert.
  const projTotals = projection
    ? {
        revenue: (projection.revenue ?? 0) + (projection.otherIncome ?? 0),
        costs:
          (projection.personnelCost ?? 0)
          + (projection.material ?? 0)
          + (projection.depreciation ?? 0)
          + (projection.otherCosts ?? 0),
        taxes: projection.taxes ?? 0,
        resultBeforeTax: 0,
        resultAfterTax: 0,
      }
    : null;
  if (projTotals) {
    projTotals.resultBeforeTax = projTotals.revenue - projTotals.costs;
    projTotals.resultAfterTax = projTotals.resultBeforeTax - projTotals.taxes;
  }

  // Spalten-Reihenfolge mit chronologisch eingefügter Hochrechnung
  type Col =
    | { kind: 'plan'; plan: PlanForCompare; year: number }
    | { kind: 'projection'; year: number };
  const cols: Col[] = plans.map((p) => ({ kind: 'plan' as const, plan: p, year: p.year }));
  if (projection) {
    cols.push({ kind: 'projection', year: projection.year });
    cols.sort((a, b) => a.year - b.year);
  }

  function cellPlan(axis: Axis, p: PlanForCompare) {
    return lineValue(p, axis);
  }
  function cellProjection(axis: Axis): number {
    if (!projection) return 0;
    switch (axis) {
      case 'REVENUE': return projection.revenue ?? 0;
      case 'OTHER_INCOME': return projection.otherIncome ?? 0;
      case 'PERSONNEL': return projection.personnelCost ?? 0;
      case 'MATERIAL': return projection.material ?? 0;
      case 'DEPRECIATION': return projection.depreciation ?? 0;
      case 'OTHER_COSTS': return projection.otherCosts ?? 0;
      case 'TAXES': return projection.taxes ?? 0;
    }
  }

  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-3 border-b border-default">
        <h3 className="text-sm font-medium text-primary">Szenario-Vergleich</h3>
        <p className="text-xs text-muted mt-0.5">
          {plans.length} Planung{plans.length === 1 ? '' : 'en'}
          {projection ? ` + Hochrechnung ${projection.year}` : ''} nebeneinander
          {plans.length > 1 && plans[0]!.year !== plans[plans.length - 1]!.year
            ? ' · Spalten chronologisch sortiert'
            : ''}
          .
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-default">
              <th className="text-left px-4 py-2 text-xs font-medium text-muted uppercase">
                Position
              </th>
              {cols.map((c, i) =>
                c.kind === 'plan' ? (
                  <th
                    key={`p-${c.plan.id}`}
                    className="text-right px-4 py-2 text-xs font-medium text-secondary"
                  >
                    <div>{c.plan.name}</div>
                    <div className="text-[10px] text-disabled font-normal">{c.plan.year}</div>
                  </th>
                ) : (
                  <th
                    key={`pr-${i}`}
                    className="text-right px-4 py-2 text-xs font-medium text-brand-700 dark:text-brand-100 bg-brand-50/40 dark:bg-brand-900/30"
                  >
                    <div>Hochrechnung</div>
                    <div className="text-[10px] text-muted font-normal">
                      {c.year} · {projection!.basis}
                    </div>
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {ORDER.map((axis) => (
              <tr key={axis}>
                <td className="px-4 py-1.5 text-secondary">{AXIS_LABELS[axis]}</td>
                {cols.map((c, i) =>
                  c.kind === 'plan' ? (
                    <td
                      key={`p-${c.plan.id}-${axis}`}
                      className="px-4 py-1.5 text-right font-mono tabular-nums text-primary"
                    >
                      {eurFmt.format(cellPlan(axis, c.plan))}
                    </td>
                  ) : (
                    <td
                      key={`pr-${i}-${axis}`}
                      className="px-4 py-1.5 text-right font-mono tabular-nums text-brand-900 dark:text-brand-100 bg-brand-50/30 dark:bg-brand-900/25"
                    >
                      {eurFmt.format(cellProjection(axis))}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t-2 border-default">
            {[
              { label: 'Erträge', key: 'revenue' as const, accent: false },
              { label: 'Aufwendungen', key: 'costs' as const, accent: false },
              { label: 'Ergebnis vor Steuern', key: 'resultBeforeTax' as const, accent: true, semibold: false },
              { label: 'Ergebnis nach Steuern', key: 'resultAfterTax' as const, accent: true, semibold: true },
            ].map((row) => (
              <tr key={row.key}>
                <td
                  className={
                    (row.semibold ? 'px-4 py-2 text-primary font-semibold' : 'px-4 py-1.5 text-secondary font-medium')
                  }
                >
                  {row.label}
                </td>
                {cols.map((c, i) => {
                  const v =
                    c.kind === 'plan'
                      ? sums[plans.findIndex((p) => p.id === c.plan.id)]![row.key]
                      : projTotals![row.key];
                  const cls =
                    row.accent && v < 0
                      ? 'text-red-700 dark:text-red-300'
                      : row.accent && v > 0
                      ? 'text-emerald-700 dark:text-emerald-300'
                      : 'text-primary';
                  return (
                    <td
                      key={`tot-${i}-${row.key}`}
                      className={
                        (row.semibold ? 'px-4 py-2' : 'px-4 py-1.5') +
                        ' text-right font-mono tabular-nums ' +
                        (row.semibold ? 'font-semibold ' : 'font-medium ') +
                        cls +
                        (c.kind === 'projection' ? ' bg-brand-50/30 dark:bg-brand-900/25' : '')
                      }
                    >
                      {eurFmt.format(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tfoot>
        </table>
      </div>
    </div>
  );
}

/**
 * Klein-Badge zeigt Herkunft eines Plans:
 *   - „Mandant" wenn vom Mandant erstellt (oder zuletzt bearbeitet)
 *   - „Kanzlei" wenn vom Staff erstellt/bearbeitet
 *   - „Mandant → Kanzlei" wenn Übergang erkennbar
 */
export function ActorBadge({
  createdByType,
  updatedByType,
}: {
  createdByType?: 'STAFF' | 'CLIENT_CONTACT';
  updatedByType?: 'STAFF' | 'CLIENT_CONTACT' | null;
}) {
  if (!createdByType) return null;
  const created = createdByType === 'STAFF' ? 'Kanzlei' : 'Mandant';
  const updated =
    updatedByType && updatedByType !== createdByType
      ? updatedByType === 'STAFF'
        ? 'Kanzlei'
        : 'Mandant'
      : null;
  const cls =
    createdByType === 'STAFF'
      ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300'
      : 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300';
  return (
    <span
      className={'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ' + cls}
      title={`Erstellt von ${created}${updated ? `, zuletzt von ${updated}` : ''}`}
    >
      {created}
      {updated && (
        <>
          <span className="mx-1 opacity-60">→</span>
          {updated}
        </>
      )}
    </span>
  );
}
