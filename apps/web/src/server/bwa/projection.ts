// =============================================================================
// Hochrechnungs-Engine für BWA-Daten.
//
// Liefert pro KPI-Achse einen Erwartungswert + Min/Max-Spanne — bewusst
// kein Punktwert, weil BWAs keine Abschlüsse sind und der Mandant nicht
// auf eine vermeintlich präzise Zahl Entscheidungen stützen soll.
//
// Zwei nebeneinanderlaufende Strategien:
//
//   1. linearSeasonal — YTD-Werte mit 12/N aufs Jahr hochrechnen. Eine echte
//      Saisongewichtung ist ohne Vorjahres-Monatsverteilung nicht belastbar;
//      die ausgewiesene Spanne wird mit zunehmender Datenabdeckung enger.
//
//   2. trendRegression — Linear-Regression über die letzten Jahre. Punkt-
//      schätzung = nächster Wert auf der Regressionsgeraden. Spanne aus
//      Standardabweichung der Residuen.
//
// Beide Strategien liefern dasselbe Result-Format, die UI zeigt sie
// nebeneinander an und der Mandant kann sich seine Meinung bilden.
// =============================================================================

import { computeBwaKpis, type BwaKpis } from './addison-parser';

export type Axis = 'revenue' | 'costs' | 'result' | 'resultBeforeTax' | 'personnelCost';

export interface ProjectionRange {
  estimate: number;
  low: number;
  high: number;
}

export interface YearProjection {
  year: number;
  strategy: 'linear' | 'trend-regression';
  revenue: ProjectionRange | null;
  costs: ProjectionRange | null;
  result: ProjectionRange | null; // Ergebnis VOR Ertragsteuern (KPI resultBeforeTax)
  personnelCost: ProjectionRange | null;
  taxes: ProjectionRange | null; // grobe Pauschal-Schätzung
  resultAfterTax: ProjectionRange | null; // Ergebnis nach Steuern
  basis: string;
}

/**
 * Grobe Steuer-Pauschale: 30 % Mittelwert auf positives Ergebnis vor Steuern,
 * 25 – 35 % Spanne. Bei Verlust → 0. Die Spanne deckt den Bereich von
 * GmbH-Standorten mit GewSt-Hebesatz 380 % (≈26 %) bis 490 % (≈31 %)
 * + KSt/SolZ-Schwankungen. Für eine echte Berechnung verweisen wir auf
 * die Kanzlei.
 */
function estimateTaxRange(resultBeforeTax: ProjectionRange | null): ProjectionRange | null {
  if (!resultBeforeTax) return null;
  const mid = resultBeforeTax.estimate <= 0 ? 0 : resultBeforeTax.estimate * 0.3;
  const low = Math.max(0, resultBeforeTax.low) * 0.25;
  const high = Math.max(0, resultBeforeTax.high) * 0.35;
  return { estimate: mid, low, high };
}

function subtractRange(a: ProjectionRange, b: ProjectionRange): ProjectionRange {
  return {
    estimate: a.estimate - b.estimate,
    // worst case: höchste Steuer + niedrigstes Ergebnis vor Steuern
    low: a.low - b.high,
    high: a.high - b.low,
  };
}

export interface PeriodInput {
  periodKey: string;
  periodType: 'YEAR' | 'QUARTER' | 'MONTH';
  fromDate: Date;
  toDate: Date;
  positions: Array<{ number: number; amount: number | { toString(): string } }>;
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function monthsCovered(p: PeriodInput): number {
  const from = p.fromDate.getUTCMonth() + 1;
  const to = p.toDate.getUTCMonth() + 1;
  const fromY = p.fromDate.getUTCFullYear();
  const toY = p.toDate.getUTCFullYear();
  return (toY - fromY) * 12 + (to - from) + 1;
}

function safeKpi(p: PeriodInput): BwaKpis {
  return computeBwaKpis(p.positions);
}

function ratio(value: number, denom: number): number {
  return denom === 0 ? 0 : value / denom;
}

// ---------------------------------------------------------------------------
// Strategie 1: Lineare Run-rate
// ---------------------------------------------------------------------------

/**
 * Nimmt die jüngste unterjährige Periode (YTD) und rechnet sie linear mit
 * 12/N hoch. Die Unsicherheitsspanne wird mit wachsender Datenabdeckung enger.
 */
export function linearSeasonalProjection(
  periods: PeriodInput[],
  targetYear: number,
): YearProjection | null {
  // Aktuelle YTD-Daten suchen: jüngste Periode im targetYear, die nicht
  // bereits das ganze Jahr abdeckt.
  const inYear = periods
    .filter((p) => p.fromDate.getUTCFullYear() === targetYear)
    .sort((a, b) => b.toDate.getTime() - a.toDate.getTime());
  const ytdMaybe = inYear.find((p) => monthsCovered(p) < 12);
  if (!ytdMaybe) return null;
  const ytd: PeriodInput = ytdMaybe;

  const ytdMonths = monthsCovered(ytd);
  const remainingMonths = 12 - ytdMonths;

  function projectAxis(axisKey: Axis): ProjectionRange | null {
    const ytdKpi = safeKpi(ytd);
    const ytdValue = (ytdKpi as unknown as Record<Axis, number | null>)[axisKey];
    if (ytdValue === null || ytdValue === undefined) return null;

    // P3-19: Die Hochrechnung ist REIN LINEAR (12/N). Eine echte Saison-
    // Gewichtung ließe sich nur mit der Vorjahres-MONATSverteilung bilden — die
    // liegt aus einer Jahres-BWA aber nicht vor. Der frühere „Saisonfaktor"
    // war toter Code (pro Vorjahr wurde dieselbe Konstante 12/N gemittelt).
    const factor = 12 / ytdMonths;

    const estimate = ytdValue * factor;
    // Spanne: ±15% bei nur 3 Monaten YTD, ±5% bei 9+ Monaten YTD
    const spreadPct = Math.max(0.05, 0.18 - 0.014 * ytdMonths);
    const remainingShare = ratio(remainingMonths, 12);
    const spread = Math.abs(estimate) * spreadPct * (0.4 + remainingShare);
    return {
      estimate,
      low: estimate - spread,
      high: estimate + spread,
    };
  }

  // Bemessungsbasis der Steuerschätzung ist das Ergebnis VOR Steuern. Bei
  // DATEV ist die generische `result`-Achse (Zeile 1380) bereits NACH Steuern —
  // sie hier zu projizieren und dann `estimateTaxRange` anzuwenden zöge die
  // Ertragsteuern ein zweites Mal ab. Deshalb `resultBeforeTax` (1345/1300 bzw.
  // Addison-Vorläufiges-Ergebnis 3250) als Basis.
  const result = projectAxis('resultBeforeTax');
  const taxes = estimateTaxRange(result);
  return {
    year: targetYear,
    strategy: 'linear',
    revenue: projectAxis('revenue'),
    costs: projectAxis('costs'),
    result,
    personnelCost: projectAxis('personnelCost'),
    taxes,
    resultAfterTax: result && taxes ? subtractRange(result, taxes) : null,
    basis: `Lfd. Jahr ${ytd.periodKey} (${ytdMonths}/12 Monate)`,
  };
}

// ---------------------------------------------------------------------------
// Strategie 2: Trend-Regression über Vorjahre
// ---------------------------------------------------------------------------

function linearRegression(points: Array<{ x: number; y: number }>): {
  slope: number;
  intercept: number;
  residualStd: number;
} | null {
  if (points.length < 2) return null;
  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  // Residuen-StdDev
  const residuals = points.map((p) => p.y - (slope * p.x + intercept));
  const meanRes = residuals.reduce((s, r) => s + r, 0) / n;
  const variance = residuals.reduce((s, r) => s + (r - meanRes) ** 2, 0) / Math.max(1, n - 1);
  return { slope, intercept, residualStd: Math.sqrt(variance) };
}

export function trendRegressionProjection(
  periods: PeriodInput[],
  targetYear: number,
): YearProjection | null {
  const fullYears = periods
    // Nur echte volle Jahre (12 Monate) — Fallback-Ranges nicht als Jahr werten.
    // Fachkatalog BWA-PROJECTION-001: Ziel- und Zukunftsjahre duerfen die
    // Regression nicht beeinflussen. `toDate` statt nur `fromDate` stellt
    // sicher, dass auch jahresuebergreifende 12-Monats-Perioden vollstaendig
    // vor dem Zieljahr enden.
    .filter(
      (p) =>
        p.periodType === 'YEAR' &&
        monthsCovered(p) === 12 &&
        p.toDate.getUTCFullYear() < targetYear,
    )
    .sort((a, b) => a.fromDate.getUTCFullYear() - b.fromDate.getUTCFullYear());
  if (fullYears.length < 2) return null;

  function projectAxis(axisKey: Axis): ProjectionRange | null {
    const points = fullYears
      .map((p) => {
        const kpi = safeKpi(p);
        const v = (kpi as unknown as Record<Axis, number | null>)[axisKey];
        if (v === null || v === undefined) return null;
        return { x: p.fromDate.getUTCFullYear(), y: v };
      })
      .filter((p): p is { x: number; y: number } => p !== null);
    if (points.length < 2) return null;
    const reg = linearRegression(points);
    if (!reg) return null;
    const estimate = reg.slope * targetYear + reg.intercept;
    // Heuristische Spanne; kein kalibriertes statistisches Konfidenzintervall.
    const spread = Math.max(reg.residualStd * 1.5, Math.abs(estimate) * 0.05);
    return {
      estimate,
      low: estimate - spread,
      high: estimate + spread,
    };
  }

  const years = fullYears.map((p) => p.fromDate.getUTCFullYear());
  // Vor-Steuer-Basis, siehe linearSeasonalProjection: DATEV 1380 wäre nach
  // Steuern und würde in estimateTaxRange doppelt besteuert.
  const result = projectAxis('resultBeforeTax');
  const taxes = estimateTaxRange(result);
  return {
    year: targetYear,
    strategy: 'trend-regression',
    revenue: projectAxis('revenue'),
    costs: projectAxis('costs'),
    result,
    personnelCost: projectAxis('personnelCost'),
    taxes,
    resultAfterTax: result && taxes ? subtractRange(result, taxes) : null,
    basis: `Trend aus ${years.length} Jahren (${years[0]}–${years[years.length - 1]})`,
  };
}

// ---------------------------------------------------------------------------
// Convenience: beide Strategien für das aktuelle Jahr
// ---------------------------------------------------------------------------

export function projectCurrentYear(periods: PeriodInput[]): {
  targetYear: number;
  linear: YearProjection | null;
  trend: YearProjection | null;
} {
  // Zieljahr: Jahr der jüngsten Periode (auch wenn die ein abgeschlossenes
  // Vorjahr ist, planen wir aufs aktuelle Kalenderjahr)
  const now = new Date();
  const targetYear = now.getUTCFullYear();

  return {
    targetYear,
    linear: linearSeasonalProjection(periods, targetYear),
    trend: trendRegressionProjection(periods, targetYear),
  };
}
