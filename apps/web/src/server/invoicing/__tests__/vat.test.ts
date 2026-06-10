import { describe, it, expect } from 'vitest';
import { computeVatTotals, vatCategory } from '../vat';

describe('computeVatTotals', () => {
  it('einheitlicher Satz: eine Gruppe, uniformRate gesetzt', () => {
    const t = computeVatTotals([
      { netAmount: 100, vatRate: 19 },
      { netAmount: 50, vatRate: 19 },
    ]);
    expect(t.groups).toEqual([{ rate: 19, net: 150, vat: 28.5 }]);
    expect(t).toMatchObject({ netAmount: 150, vatAmount: 28.5, totalAmount: 178.5, uniformRate: 19 });
  });

  it('Mischsätze: Gruppen je Satz (absteigend), uniformRate null', () => {
    const t = computeVatTotals([
      { netAmount: 100, vatRate: 19 },
      { netAmount: 100, vatRate: 7 },
      { netAmount: 50, vatRate: 0 },
    ]);
    expect(t.groups).toEqual([
      { rate: 19, net: 100, vat: 19 },
      { rate: 7, net: 100, vat: 7 },
      { rate: 0, net: 50, vat: 0 },
    ]);
    expect(t).toMatchObject({ netAmount: 250, vatAmount: 26, totalAmount: 276, uniformRate: null });
  });

  it('rundet die USt je GRUPPE, nicht je Position (keine Akkumulation)', () => {
    // 3 × 0,33 € zu 19 % → Gruppe: 0,99 € Netto, USt 0,1881 → 0,19
    // (je Position gerundet wären es 3 × 0,06 = 0,18)
    const t = computeVatTotals([
      { netAmount: 0.33, vatRate: 19 },
      { netAmount: 0.33, vatRate: 19 },
      { netAmount: 0.33, vatRate: 19 },
    ]);
    expect(t.groups[0]).toEqual({ rate: 19, net: 0.99, vat: 0.19 });
  });

  it('leere Positionsliste: Null-Summen ohne Gruppen', () => {
    expect(computeVatTotals([])).toEqual({
      groups: [], netAmount: 0, vatAmount: 0, totalAmount: 0, uniformRate: null,
    });
  });
});

describe('vatCategory', () => {
  it('Satz > 0 → S, Satz 0 → Z', () => {
    expect(vatCategory(19)).toBe('S');
    expect(vatCategory(7)).toBe('S');
    expect(vatCategory(0)).toBe('Z');
  });
});
