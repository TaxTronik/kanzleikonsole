// Fachkatalog: INV-STORNO-REFERENCE-001
import { describe, expect, it } from 'vitest';
import { toStornoPosition } from '../storno';

describe('toStornoPosition', () => {
  it('invertiert eine reguläre Zeile über die Menge und hält den Preis positiv', () => {
    expect(
      toStornoPosition({
        position: 1,
        description: 'Beratung',
        quantity: 1.5,
        unitPrice: 120,
        unit: 'Stunde',
        netAmount: 180,
        vatRate: 19,
      }),
    ).toEqual({
      position: 1,
      description: 'Beratung',
      quantity: -1.5,
      unitPrice: 120,
      unit: 'Stunde',
      netAmount: -180,
      vatRate: 19,
    });
  });

  it('normalisiert auch einen Altbeleg mit negativem Preis BR-27-konform', () => {
    const correction = toStornoPosition({
      position: 1,
      description: 'Altbestand',
      quantity: 2,
      unitPrice: -50,
      unit: 'Stück',
      netAmount: -100,
      vatRate: 19,
    });
    expect(correction.unitPrice).toBe(50);
    expect(correction.quantity).toBe(2);
    expect(correction.netAmount).toBe(100);
    expect(correction.quantity * correction.unitPrice).toBe(correction.netAmount);
  });
});
