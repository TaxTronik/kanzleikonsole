import type { ProjectionSnapshot } from '@/app/portal/(protected)/bwa/plan/plan-comparison';
import { computeBwaPlanBasis } from '@/server/bwa/plan-basis';
import type { PeriodInput, ProjectionRange, YearProjection } from '@/server/bwa/projection';

type SourcePeriod = PeriodInput & { source: 'DATEV' | 'ADDISON' | 'MANUAL' };

function estimate(range: ProjectionRange | null): number | null {
  return range?.estimate ?? null;
}

function monthsCovered(period: PeriodInput): number {
  return (
    (period.toDate.getUTCFullYear() - period.fromDate.getUTCFullYear()) * 12 +
    period.toDate.getUTCMonth() -
    period.fromDate.getUTCMonth() +
    1
  );
}

/** BWA-PROJECTION-001: Bekannte Teilachsen ergänzen; fehlende Werte und die
 * eigenständige Ergebnisachse der Hochrechnung unverändert weiterreichen. */
export function buildProjectionSnapshot(
  projection: YearProjection | null,
  periods: SourcePeriod[],
): ProjectionSnapshot | null {
  if (!projection) return null;
  const ytdPeriod =
    projection.strategy === 'linear'
      ? periods
          .filter((period) => period.fromDate.getUTCFullYear() === projection.year)
          .sort((a, b) => b.toDate.getTime() - a.toDate.getTime())
          .find((period) => monthsCovered(period) < 12)
      : undefined;
  const basis = ytdPeriod ? computeBwaPlanBasis(ytdPeriod.positions, ytdPeriod.source) : null;
  const factor = ytdPeriod ? 12 / monthsCovered(ytdPeriod) : 1;
  const annualize = (amount: number | null | undefined) =>
    amount == null ? null : amount * factor;
  const material = annualize(basis?.material);
  const depreciation = annualize(basis?.depreciation);
  const personnelCost = estimate(projection.personnelCost);
  const costs = estimate(projection.costs);
  const otherCosts =
    costs !== null && personnelCost !== null && material !== null && depreciation !== null
      ? costs - personnelCost - material - depreciation
      : null;

  return {
    year: projection.year,
    revenue: estimate(projection.revenue),
    otherIncome: annualize(basis?.otherIncome),
    personnelCost,
    material,
    depreciation,
    otherCosts,
    costs,
    resultBeforeTax: estimate(projection.result),
    taxes: estimate(projection.taxes),
    resultAfterTax: estimate(projection.resultAfterTax),
    basis: projection.basis,
  };
}
