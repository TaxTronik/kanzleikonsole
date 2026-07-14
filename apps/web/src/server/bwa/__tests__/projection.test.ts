import { describe, it, expect } from 'vitest';
import { computeBwaKpis } from '../addison-parser';
import { linearSeasonalProjection, type PeriodInput } from '../projection';

// DATEV-BWA-Zeilen: 1051 Gesamtleistung, 1100 Personal, 1345 Ergebnis VOR
// Steuern, 1380 vorläufiges Ergebnis NACH Steuern. Addison-Kompaktform: 1990
// Erlöse, 3250 vorläufiges Ergebnis (ohne Steuerzeile → vor Steuern).

describe('computeBwaKpis — Vor-/Nach-Steuer-Trennung', () => {
  it('DATEV: result = 1380 (nach Steuern), resultBeforeTax = 1345 (vor Steuern)', () => {
    const kpi = computeBwaKpis([
      { number: 1051, amount: 500_000 },
      { number: 1345, amount: 100_000 }, // vor Steuern
      { number: 1380, amount: 60_000 }, // nach Steuern
    ]);
    expect(kpi.result).toBe(60_000);
    expect(kpi.resultBeforeTax).toBe(100_000);
  });

  it('Addison-Kompaktform: 3250 dient als Vor-Steuer-Fallback', () => {
    const kpi = computeBwaKpis([
      { number: 1990, amount: 175_369 },
      { number: 3250, amount: 69_004 },
    ]);
    // Ohne DATEV-Steuerzeile ist das vorläufige Addison-Ergebnis der beste
    // Vor-Steuer-Wert.
    expect(kpi.resultBeforeTax).toBe(69_004);
    expect(kpi.result).toBe(69_004);
  });
});

describe('linearSeasonalProjection — keine Doppelbesteuerung (Regression #9)', () => {
  it('projiziert das Ergebnis VOR Steuern (1345), nicht das Nach-Steuer-Ergebnis (1380)', () => {
    // Halbjahres-YTD (6/12 → Faktor 2): 1345 = 100k vor Steuern, 1380 = 60k nach.
    const ytd: PeriodInput = {
      periodKey: '2026-H1',
      periodType: 'QUARTER',
      fromDate: new Date(Date.UTC(2026, 0, 1)),
      toDate: new Date(Date.UTC(2026, 5, 30)),
      positions: [
        { number: 1051, amount: 250_000 },
        { number: 1345, amount: 100_000 }, // vor Steuern
        { number: 1380, amount: 60_000 }, // nach Steuern (darf NICHT die Basis sein)
      ],
    };

    const proj = linearSeasonalProjection([ytd], 2026);
    expect(proj).not.toBeNull();

    // Basis muss 1345 * (12/6) = 200.000 sein. Vor dem Fix wäre es 1380 * 2 =
    // 120.000 gewesen — und darauf nochmals ~30 % Steuer.
    expect(proj!.result!.estimate).toBe(200_000);
    // Steuerpauschale 30 % auf das Vor-Steuer-Ergebnis.
    expect(proj!.taxes!.estimate).toBe(60_000);
    // Nach-Steuer = Vor-Steuer − Steuer, EINMAL abgezogen.
    expect(proj!.resultAfterTax!.estimate).toBe(140_000);
  });
});
