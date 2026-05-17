// =============================================================================
// Liquiditäts-Indikatoren aus BWA-Daten (PNL-Proxies).
//
// Wichtig: Echte Liquiditätskennzahlen (1./2./3. Grades) brauchen Bilanz-/
// Bestandsdaten (Bank, Kasse, Forderungen, Verbindlichkeiten). Aus einer
// reinen BWA können wir die nicht berechnen — wir liefern statt­dessen
// PNL-Proxies, die einem Mandant erlauben, Liquiditäts-Trends zu erkennen:
//
//   - Operativer Cashflow-Proxy = vorl. Ergebnis + Abschreibungen
//   - Monatlicher Cashflow-Durchschnitt
//   - Margen-Entwicklung (auf-/abwärts)
//   - Personalkostenquote (Trend)
//   - „Runway-Hinweis": bei negativem Cashflow Hinweis auf Liquiditätsrisiko
//
// Die UI muss diese Werte mit einem Disclaimer kennzeichnen — sie sind
// keine Bilanzkennzahlen und ersetzen keine Liquiditätsplanung.
// =============================================================================

import { computeBwaKpis } from './addison-parser';

// Pos 3100 in Addison = Abschreibungen (DATEV: 1200)
const ADDISON_DEPRECIATION = 3100;
const DATEV_DEPRECIATION = 1200;

export interface LiquidityKpis {
  monthsCovered: number;
  cashflowProxy: number | null;            // Ergebnis + Abschreibungen, Jahresbasis
  cashflowMonthly: number | null;          // /Monat
  marginPct: number | null;                // Ergebnis / Erlöse
  personnelRatioPct: number | null;        // Personalkosten / Erlöse
  marginTrend: 'up' | 'down' | 'flat' | null;
  personnelTrend: 'up' | 'down' | 'flat' | null;
  warning: string | null;                  // z. B. Hinweis auf Liquiditätsrisiko
}

export interface PeriodInput {
  periodKey: string;
  periodType: 'YEAR' | 'QUARTER' | 'MONTH';
  fromDate: Date;
  toDate: Date;
  positions: Array<{ number: number; amount: number | { toString(): string } }>;
}

function monthsCovered(p: PeriodInput): number {
  const from = p.fromDate.getUTCMonth() + 1;
  const to = p.toDate.getUTCMonth() + 1;
  const fromY = p.fromDate.getUTCFullYear();
  const toY = p.toDate.getUTCFullYear();
  return (toY - fromY) * 12 + (to - from) + 1;
}

function depreciation(positions: PeriodInput['positions']): number {
  for (const p of positions) {
    if (p.number === ADDISON_DEPRECIATION || p.number === DATEV_DEPRECIATION) {
      return typeof p.amount === 'number' ? p.amount : Number(p.amount.toString());
    }
  }
  return 0;
}

function trend(curr: number | null, prev: number | null): 'up' | 'down' | 'flat' | null {
  if (curr === null || prev === null) return null;
  const delta = curr - prev;
  const ref = Math.abs(prev) || 1;
  if (Math.abs(delta) / ref < 0.02) return 'flat';
  return delta > 0 ? 'up' : 'down';
}

/**
 * Liefert Liquiditäts-Indikatoren für eine Referenz-Periode + Vergleich
 * zur gleichartigen Vorperiode (Jahr/Quartal/Monat).
 */
export function computeLiquidity(
  current: PeriodInput,
  previous: PeriodInput | null,
): LiquidityKpis {
  const currKpi = computeBwaKpis(current.positions);
  const currDep = depreciation(current.positions);
  const months = monthsCovered(current);

  const cashflowProxy =
    currKpi.result !== null ? currKpi.result + currDep : null;
  const cashflowMonthly =
    cashflowProxy !== null && months > 0 ? cashflowProxy / months : null;
  const marginPct =
    currKpi.revenue && currKpi.revenue > 0 && currKpi.result !== null
      ? (currKpi.result / currKpi.revenue) * 100
      : null;
  const personnelRatioPct =
    currKpi.revenue && currKpi.revenue > 0 && currKpi.personnelCost !== null
      ? (currKpi.personnelCost / currKpi.revenue) * 100
      : null;

  let marginTrend: LiquidityKpis['marginTrend'] = null;
  let personnelTrend: LiquidityKpis['personnelTrend'] = null;
  if (previous) {
    const prevKpi = computeBwaKpis(previous.positions);
    const prevMarginPct =
      prevKpi.revenue && prevKpi.revenue > 0 && prevKpi.result !== null
        ? (prevKpi.result / prevKpi.revenue) * 100
        : null;
    const prevPersonnel =
      prevKpi.revenue && prevKpi.revenue > 0 && prevKpi.personnelCost !== null
        ? (prevKpi.personnelCost / prevKpi.revenue) * 100
        : null;
    marginTrend = trend(marginPct, prevMarginPct);
    personnelTrend = trend(personnelRatioPct, prevPersonnel);
  }

  let warning: string | null = null;
  if (cashflowMonthly !== null && cashflowMonthly < 0) {
    warning =
      'Negativer operativer Cashflow — wir empfehlen eine kurzfristige Liquiditätsplanung mit Ihrer Kanzlei.';
  } else if (marginPct !== null && marginPct < 5 && marginTrend === 'down') {
    warning =
      'Marge unter 5 % und rückläufig — Frühwarnsignal für Liquiditätsdruck.';
  } else if (personnelRatioPct !== null && personnelRatioPct > 55 && personnelTrend === 'up') {
    warning =
      'Personalkostenquote über 55 % und steigend — Liquiditätspuffer prüfen.';
  }

  return {
    monthsCovered: months,
    cashflowProxy,
    cashflowMonthly,
    marginPct,
    personnelRatioPct,
    marginTrend,
    personnelTrend,
    warning,
  };
}
