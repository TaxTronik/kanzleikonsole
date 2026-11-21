import type { planTotals } from '@/lib/bwa-plan';
import { fmtEURRound } from '@/lib/fmt';

export function PlanSummary({ totals }: { totals: ReturnType<typeof planTotals> }) {
  return (
    <>
      <Total label="Erträge" value={totals.totalIncome} />
      <Total label="Aufwendungen" value={totals.costs} />
      <Total label="Ergebnis vor Steuern" value={totals.resultBeforeTax} accent />
      <Total label="Ergebnis nach Steuern" value={totals.resultAfterTax} accent />
    </>
  );
}

function Total({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div>
      <p className="text-xs text-muted">{label}</p>
      <p
        className={
          'text-lg font-bold font-mono ' +
          (accent && value < 0
            ? 'text-red-700'
            : accent && value > 0
              ? 'text-emerald-700'
              : 'text-primary')
        }
      >
        {fmtEURRound(value)}
      </p>
    </div>
  );
}
