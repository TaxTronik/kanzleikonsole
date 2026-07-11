import { describe, expect, it, vi } from 'vitest';
import {
  buildTimeBillingPositions,
  claimTimeEntriesForInvoice,
  validateTimeBillingTax,
} from '../time-billing';

const tenMinutes = {
  entry: {
    startedAt: new Date(Date.UTC(2026, 6, 10, 8, 0)),
    description: 'Telefonberatung',
  },
  minutes: 10,
  hours: 10 / 60,
  rate: 120,
  net: 20,
};

describe('buildTimeBillingPositions', () => {
  it('hält bei per-entry quantity × unitPrice === netAmount exakt ein', () => {
    const [position] = buildTimeBillingPositions([tenMinutes], 'per-entry', 'Beratung', 19);
    expect(position).toMatchObject({ quantity: 1, unitPrice: 20, netAmount: 20 });
    expect(position!.quantity * position!.unitPrice).toBe(position!.netAmount);
    expect(position!.description).toContain('10 Min.');
    expect(position!.description).toContain('120.00 €/Std.');
  });

  it('bildet auch die Sammelposition als rechenfeste Pauschale', () => {
    const [position] = buildTimeBillingPositions(
      [tenMinutes, { ...tenMinutes, net: 30, minutes: 15, hours: 0.25 }],
      'one-line',
      'Beratung',
      7,
    );
    expect(position).toMatchObject({
      quantity: 1,
      unitPrice: 50,
      netAmount: 50,
      vatRate: 7,
    });
  });
});

describe('claimTimeEntriesForInvoice', () => {
  it('beansprucht ausschließlich noch freie Einträge', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 2 });
    await expect(
      claimTimeEntriesForInvoice(
        { timeEntry: { updateMany } },
        ['entry-1', 'entry-2'],
        'invoice-1',
      ),
    ).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['entry-1', 'entry-2'] }, invoiceId: null },
      data: { invoiceId: 'invoice-1' },
    });
  });

  it('meldet einen verlorenen Parallel-Claim bei Teilmenge', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    await expect(
      claimTimeEntriesForInvoice(
        { timeEntry: { updateMany } },
        ['entry-1', 'entry-2'],
        'invoice-2',
      ),
    ).resolves.toBe(false);
  });
});

describe('validateTimeBillingTax', () => {
  it('verlangt bei 0 % entweder Befreiungsgrund oder Reverse-Charge', () => {
    expect(
      validateTimeBillingTax({
        vatRate: 0,
        reverseCharge: false,
        vatExemptionReason: null,
      }),
    ).toMatch(/Befreiungsgrund/);
    expect(
      validateTimeBillingTax({
        vatRate: 0,
        reverseCharge: false,
        vatExemptionReason: '§ 19 UStG',
      }),
    ).toBeNull();
    expect(
      validateTimeBillingTax({
        vatRate: 0,
        reverseCharge: true,
        vatExemptionReason: null,
      }),
    ).toBeNull();
  });

  it('lehnt Reverse-Charge mit ausgewiesener USt und freie Fantasiesätze ab', () => {
    expect(
      validateTimeBillingTax({
        vatRate: 19,
        reverseCharge: true,
        vatExemptionReason: null,
      }),
    ).toMatch(/0 %/);
    expect(
      validateTimeBillingTax({
        vatRate: 13,
        reverseCharge: false,
        vatExemptionReason: null,
      }),
    ).toMatch(/Ungültiger USt-Satz/);
  });
});
