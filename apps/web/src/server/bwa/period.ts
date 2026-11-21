export interface PeriodInput {
  periodKey: string;
  periodType: 'YEAR' | 'QUARTER' | 'MONTH';
  fromDate: Date;
  toDate: Date;
  positions: Array<{ number: number; amount: number | { toString(): string } }>;
}

/** Inklusive Kalendermonate zwischen zwei DATE-Spalten. */
export function monthsCovered(p: Pick<PeriodInput, 'fromDate' | 'toDate'>): number {
  const from = p.fromDate.getUTCMonth() + 1;
  const to = p.toDate.getUTCMonth() + 1;
  const fromY = p.fromDate.getUTCFullYear();
  const toY = p.toDate.getUTCFullYear();
  return (toY - fromY) * 12 + (to - from) + 1;
}
