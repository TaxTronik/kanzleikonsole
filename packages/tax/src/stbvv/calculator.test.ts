// Fachkatalog: STBVV-CALCULATION-001, INV-VAT-TOTALS-001.
import { describe, it, expect } from 'vitest';
import data from './tables.json';
import { STBVV_CATALOG, STBVV_VERSION } from './catalog';
import {
  calculateStbvv,
  fullFeeCents,
  closingValue,
  documentExpenseCents,
  type FeeLineInput,
  type FeeCalculationInput,
} from './calculator';
const line = (feeId: string, patch: Partial<FeeLineInput> = {}): FeeLineInput => ({
  id: feeId,
  feeId,
  matter: 'Auftrag 2026',
  rate: STBVV_CATALOG.find((d) => d.id === feeId)!.min,
  rawValue: 10000,
  quantity: 1,
  minutes: 16,
  weightedHectares: 40,
  manualAmount: 250,
  justification: 'Nach Aktenlage einzeln geprüft und begründet.',
  ...patch,
});
const calc = (lines: FeeLineInput[], patch: Partial<FeeCalculationInput> = {}) =>
  calculateStbvv({
    lawVersion: STBVV_VERSION,
    currentLawConfirmed: true,
    matterReviewConfirmed: true,
    lines,
    expenses: [],
    vatRate: 19,
    ...patch,
  });
describe('STBVV-CALCULATION-001: source tables and full fee inventory', () => {
  it('contains every active return item, including 11a and minimum tax; removed items absent', () => {
    for (const n of [
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '10',
      '11',
      '11a',
      '12',
      '13',
      '14',
      '15',
      '16',
      '17',
      '18',
      '19',
      '20',
      '21',
      '22',
      '23',
      '25',
      '26',
    ])
      expect(STBVV_CATALOG.some((d) => d.id === `24-1-${n}`)).toBe(true);
    expect(
      STBVV_CATALOG.some((d) => ['24-1-9', '24-1-24', '35-1-1c', '35-1-8'].includes(d.id)),
    ).toBe(false);
    expect(new Set(STBVV_CATALOG.map((d) => d.id)).size).toBe(STBVV_CATALOG.length);
    for (let section = 21; section <= 40; section++)
      expect(STBVV_CATALOG.some((d) => d.id.split('-')[0] === String(section))).toBe(true);
    expect(STBVV_CATALOG.find((d) => d.id === '37-1-1')!.provision).toBe('§ 37 Nr. 1 StBVV');
    expect(STBVV_CATALOG.find((d) => d.id === '23-2-3')!.provision).toBe(
      '§ 23 Abs. 2 Satz 3 StBVV',
    );
    expect(STBVV_CATALOG.find((d) => d.id === '36-2-1zeit')!.provision).toBe(
      '§ 36 Abs. 2 Nr. 1 StBVV',
    );
  });
  it('honours all imported inclusive boundaries and independently checked annex endpoints', () => {
    expect(Object.fromEntries(Object.entries(data.tables).map(([k, v]) => [k, v.length]))).toEqual({
      A: 49,
      B: 61,
      C: 23,
      Da: 59,
      Db: 85,
    });
    for (const [table, rows] of Object.entries(data.tables))
      for (const [value, fee] of rows)
        expect(fullFeeCents(table as keyof typeof data.tables, value!)).toBe(
          Math.round(fee! * 100),
        );
    expect(fullFeeCents('A', 300)).toBe(3100);
    expect(fullFeeCents('A', 300.01)).toBe(5600);
    expect(fullFeeCents('B', 50000000)).toBe(692300);
    expect(fullFeeCents('B', 50000001)).toBe(719600);
  });
  it('adds graduated excess amounts without repricing the whole value', () => {
    expect(fullFeeCents('A', 600000.01)).toBe((3404 + 149) * 100);
    expect(fullFeeCents('A', 5000000)).toBe((3404 + 88 * 149) * 100);
    expect(fullFeeCents('A', 5000000.01)).toBe((3404 + 88 * 149 + 112) * 100);
    expect(fullFeeCents('B', 125000001)).toBe((6923 + 15 * 273 + 477) * 100);
    expect(fullFeeCents('B', 250000001)).toBe((6923 + 15 * 273 + 10 * 477 + 681) * 100);
    expect(fullFeeCents('C', 500001)).toBe(54800);
    expect(fullFeeCents('Db', 500001)).toBe(301300);
    expect(fullFeeCents('Da', 1000.5)).toBe(184385);
    expect(fullFeeCents('Da', 2001)).toBe(353453);
  });
  it('has an executable explicit calculation path for every catalogue entry', () => {
    for (const d of STBVV_CATALOG) {
      const lines = [line(d.id)];
      if (d.id === '36-2-1') lines.push(line('36-2-1zeit'));
      if (d.id === '36-2-1zeit') lines.push(line('36-2-1'));
      const result = calc(lines);
      expect(result.netCents).toBeGreaterThan(0);
      expect(result.lines[0]!.manual).toBe(d.kind === 'EXTERNAL');
    }
  });
  it('uses /20 not /10 and transforms the raw VAT basis before flooring', () => {
    expect(calc([line('24-1-11a', { rawValue: 0, rate: 1 })]).lines[0]!.netCents).toBe(4270);
    expect(calc([line('24-1-7', { rawValue: 100000 })]).lines[0]!.value).toBe(10000);
    expect(calc([line('24-1-10', { rawValue: 0, nonNaturalPerson: true })]).lines[0]!.value).toBe(
      25000,
    );
    expect(calc([line('24-1-4', { rawValue: 3000000 })]).lines[0]!.value).toBe(30000);
    expect(calc([line('24-1-4', { rawValue: -3000000 })]).lines[0]!.value).toBe(30000);
    expect(calc([line('24-1-3', { rawValue: -100000 })]).lines[0]!.value).toBe(16000);
    expect(calc([line('24-1-5', { rawValue: -100000 })]).lines[0]!.value).toBe(8000);
    expect(() => calc([line('24-1-1', { rawValue: -100000 })])).toThrow('ungültiger');
  });
  it('caps a first consumer consultation before credits and prohibits duplicate charging', () => {
    expect(
      calc([line('21-1', { rawValue: 1000000, rate: 10, consumerFirstConsultation: true })])
        .netCents,
    ).toBe(19000);
    expect(() => calc([line('21-1', { quantity: 2, consumerFirstConsultation: true })])).toThrow(
      'einmal',
    );
    expect(() => calc([line('23-1-2'), line('23-1-5')])).toThrow('höchstem');
    expect(() => calc([line('24-1-7'), line('33-1')])).toThrow('abgegolten');
    expect(() => calc([line('24-1-15'), line('34-2')])).toThrow('abgegolten');
    expect(() => calc([line('23-2-3', { quantity: 3 })])).toThrow('nur eine');
  });
  it('charges commenced quarters and applies minimum tax report credit only to its group', () => {
    expect(calc([line('28', { minutes: 15, rate: 16.5 })]).netCents).toBe(1650);
    expect(calc([line('28', { minutes: 16, rate: 16.5 })]).netCents).toBe(3300);
    const result = calc([
      line('24-1-4', { rawValue: 0, rate: 8 }),
      line('24-5-5', { minutes: 999, rate: 41 }),
    ]);
    expect(result.lines[0]!.creditCents).toBe(28200);
    expect(result.lines[0]!.netCents).toBe(28200);
    expect(
      calc([line('24-1-4'), line('24-5-5', { matter: 'Andere Gruppe' })]).lines[0]!.creditCents,
    ).toBe(0);
  });
  it('credits a consultation once and never yields a negative target', () => {
    const result = calc([line('21-1', { rate: 10 }), line('24-1-1', { creditFromLineId: '21-1' })]);
    expect(result.lines[1]!.netCents).toBe(0);
    expect(() =>
      calc([
        line('21-1'),
        line('24-1-1', { creditFromLineId: '21-1' }),
        line('24-1-2', { creditFromLineId: '21-1' }),
      ]),
    ).toThrow('einmalige');
  });
  it('adds D a and D b and halves the closing excess before the lookup', () => {
    const result = calc([line('39-3-2', { rawValue: 200000, weightedHectares: 40, rate: 10 })]);
    expect(result.lines[0]!.value).toBe(150000);
    expect(result.netCents).toBe((369 + 1146) * 100);
    expect(calc([line('39-4-1', { weightedHectares: 40, rate: 6 })]).netCents).toBe(22140);
  });
  it('handles §35 cap, absolute balance and explicit overlap refusal', () => {
    expect(closingValue(-100000, 1000000, 0)).toBe(300000);
    expect(closingValue(100000, 1000, 120000)).toBe(100000);
    expect(closingValue(1000, 10000, 20000)).toBe(10000);
    expect(() => closingValue(1000, 1000, 1000)).toThrow('beide');
  });
  it('VV7000 pages and expense boundaries; INV-VAT-TOTALS-001 group rounding', () => {
    expect(documentExpenseCents(51, 51)).toBe(7545);
    const expenses: FeeCalculationInput['expenses'] = [
      {
        id: 'post',
        matter: 'Auftrag 2026',
        kind: 'POST_PERCENT',
        justification: 'Postleistung im Auftrag erbracht.',
      },
      {
        id: 'trip',
        matter: 'Auftrag 2026',
        kind: 'TRAVEL_KM',
        km: 10,
        justification: 'Geschäftsreise außerhalb der Gemeinde.',
      },
      {
        id: 'absence',
        matter: 'Auftrag 2026',
        kind: 'ABSENCE',
        hours: 4.01,
        foreignUplift: true,
        justification: 'Auslandstermin mit dokumentierter Dauer.',
      },
    ];
    const result = calc([line('24-1-1', { rate: 6 })], { expenses });
    expect(result.expenses.map((e) => e.netCents)).toEqual([2000, 420, 7500]);
    expect(result.vatCents).toBe(Math.round(result.netCents * 0.19));
    expect(() =>
      calc([line('24-1-1')], {
        expenses: [expenses[0]!, { ...expenses[0]!, id: 'post2', kind: 'POST_ACTUAL', amount: 20 }],
      }),
    ).toThrow('nicht kombinieren');
  });
  it('rejects unreviewed law selection, unsupported rates and non-finite money', () => {
    expect(() => calc([line('24-1-1')], { currentLawConfirmed: false })).toThrow('Rechtsstand');
    expect(() => calc([line('24-1-1')], { lawVersion: '2020' })).toThrow('Rechtsstand');
    expect(() => calc([line('24-1-1', { rate: 9 })])).toThrow('Rahmen');
    expect(() => calc([line('24-1-1', { rawValue: NaN })])).toThrow('ungültiger');
    expect(() => calc([line('24-1-1')], { vatRate: 0 })).toThrow('Befreiungsgrund');
  });
});
