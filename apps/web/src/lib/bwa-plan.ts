export const BWA_PLAN_AXES = [
  'REVENUE',
  'OTHER_INCOME',
  'PERSONNEL',
  'MATERIAL',
  'DEPRECIATION',
  'OTHER_COSTS',
  'TAXES',
] as const;
export type PlanAxis = (typeof BWA_PLAN_AXES)[number];

export const PLAN_AXIS_LABELS: Record<PlanAxis, string> = {
  REVENUE: 'Erlöse',
  PERSONNEL: 'Personalkosten',
  OTHER_COSTS: 'Sonstige Kosten',
  DEPRECIATION: 'Abschreibungen',
  MATERIAL: 'Material-/Wareneinkauf',
  OTHER_INCOME: 'Sonstige Erträge',
  TAXES: 'Steuern (GewSt/KSt/ESt)',
};

// Wie DECIMAL(14,2) in BwaPlanLine: Beträge pro Achse auf Cent runden,
// bei genau einem halben Cent vom Nullpunkt weg, auch bei negativen Beträgen.
// Intl rundet den Dezimalwert. Ein vorheriges Multiplizieren als Gleitkommazahl
// würde z. B. aus 1,005 Euro nur 100,49999999999999 Cent machen.
const planCurrency = new Intl.NumberFormat('en-US', {
  useGrouping: false,
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** BWA-PROJECTION-001: Erlöse und sonstige Erträge bleiben einzeln ausweisbar. */
export function planTotals(amount: (axis: PlanAxis) => number) {
  const cents = (axis: PlanAxis) => Number(planCurrency.format(amount(axis)).replace('.', ''));
  const revenue = cents('REVENUE');
  const totalIncome = revenue + cents('OTHER_INCOME');
  const personnelCost = cents('PERSONNEL');
  const costs = personnelCost + cents('OTHER_COSTS') + cents('DEPRECIATION') + cents('MATERIAL');
  const taxes = cents('TAXES');
  const resultBeforeTax = totalIncome - costs;
  return {
    revenue: revenue / 100,
    totalIncome: totalIncome / 100,
    personnelCost: personnelCost / 100,
    costs: costs / 100,
    taxes: taxes / 100,
    resultBeforeTax: resultBeforeTax / 100,
    resultAfterTax: (resultBeforeTax - taxes) / 100,
  };
}

type SavedPlan = { lines: ReadonlyArray<{ axis: string; amount: number }> };

export function planLineAmount(plan: SavedPlan, axis: PlanAxis): number {
  return plan.lines.find((line) => line.axis === axis)?.amount ?? 0;
}

export function savedPlanTotals(plan: SavedPlan) {
  return planTotals((axis) => planLineAmount(plan, axis));
}
