import data from './tables.json';
import { STBVV_CATALOG, STBVV_VERSION, type FeeDefinition } from './catalog';

export class FeeInputError extends Error {}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new FeeInputError(message);
}
export function feeNumber(n: number, label: string, max = 1e12): number {
  if (!Number.isFinite(n) || n < 0 || n > max)
    throw new FeeInputError(`${label}: ungültiger Betrag.`);
  return n;
}
const cents = (n: number) => Math.round((n + Number.EPSILON) * 100);
type TableName = keyof typeof data.tables;
/** Each 'bis' boundary is inclusive. Continuations use only the EXCESS. */
export function fullFeeCents(table: TableName, value: number): number {
  feeNumber(value, 'Gegenstandswert');
  const rows = data.tables[table];
  const row = rows.find((r) => value <= r[0]!);
  if (row) return cents(row[1]!);
  const last = rows[rows.length - 1]!;
  let fee = last[1]!;
  let lower = last[0]!;
  const steps: Array<[number, number, number]> =
    table === 'A'
      ? [
          [5_000_000, 50_000, 149],
          [25_000_000, 50_000, 112],
          [Infinity, 50_000, 88],
        ]
      : table === 'B'
        ? [
            [125_000_000, 5_000_000, 273],
            [250_000_000, 12_500_000, 477],
            [Infinity, 25_000_000, 681],
          ]
        : table === 'C'
          ? [[Infinity, 50_000, 36]]
          : table === 'Db'
            ? [[Infinity, 50_000, 165]]
            : [
                [2000, 1, 1.69],
                [3000, 1, 1.53],
                [4000, 1, 1.38],
                [5000, 1, 1.22],
                [6000, 1, 1.07],
                [7000, 1, 0.92],
                [8000, 1, 0.76],
                [9000, 1, 0.6],
                [10000, 1, 0.46],
                [11000, 1, 0.3],
                [12000, 1, 0.16],
                [Infinity, 1, 0.16],
              ];
  for (const [upper, step, increment] of steps) {
    const excess = Math.max(0, Math.min(value, upper) - lower);
    // D a says 'je ha', without 'angefangene'; fractions remain proportional.
    fee += (table === 'Da' ? excess : Math.ceil(excess / step)) * increment;
    lower = upper;
    if (value <= upper) break;
  }
  return cents(fee);
}

export interface FeeLineInput {
  id: string;
  feeId: string;
  matter: string;
  rate: number;
  rawValue?: number;
  weightedHectares?: number;
  quantity?: number;
  minutes?: number;
  consumerFirstConsultation?: boolean;
  nonNaturalPerson?: boolean;
  manualAmount?: number;
  justification: string;
  creditFromLineId?: string;
}
export type ExpenseKind =
  | 'POST_PERCENT'
  | 'POST_ACTUAL'
  | 'DOCUMENTS'
  | 'ELECTRONIC_DOCUMENTS'
  | 'TRAVEL_KM'
  | 'ABSENCE'
  | 'ACTUAL';
export interface FeeExpenseInput {
  id: string;
  matter: string;
  kind: ExpenseKind;
  justification: string;
  amount?: number;
  pagesBw?: number;
  pagesColor?: number;
  files?: number;
  scanEquivalentCents?: number;
  km?: number;
  hours?: number;
  foreignUplift?: boolean;
}
export interface FeeCalculationInput {
  lawVersion: string;
  currentLawConfirmed: boolean;
  matterReviewConfirmed: boolean;
  lines: FeeLineInput[];
  expenses: FeeExpenseInput[];
  vatRate: 0 | 19;
  vatExemptionReason?: string;
}
export interface FeeCalculatedLine {
  id: string;
  matter: string;
  feeId: string;
  description: string;
  provision: string;
  source: string;
  baseFeeCents: number | null;
  value: number | null;
  rate: number;
  denominator: number;
  quantity: number;
  beforeCreditCents: number;
  creditCents: number;
  netCents: number;
  trace: string[];
  manual: boolean;
}
export interface FeeCalculation {
  lawVersion: string;
  tableVersion: string;
  lines: FeeCalculatedLine[];
  expenses: Array<{ id: string; matter: string; description: string; netCents: number }>;
  netCents: number;
  vatCents: number;
  grossCents: number;
  warnings: string[];
}

/** Optional transparent helper. Ambiguous overlapping statutory exceptions
 * are rejected, so they cannot silently enter a saved result. */
export function closingValue(
  correctedBalance: number,
  annualPerformance: number,
  annualExpense: number,
): number {
  check(Number.isFinite(correctedBalance), 'Bilanzsumme fehlt.');
  const balance = Math.abs(correctedBalance);
  feeNumber(annualPerformance, 'Jahresleistung');
  feeNumber(annualExpense, 'Jahresaufwand');
  check(
    !(balance < 3000 && annualPerformance < 3000),
    '§ 35 Abs. 2: beide 3.000-Euro-Ausnahmen betroffen; Gegenstandswert fachlich bestimmen.',
  );
  if (annualPerformance < 3000) return balance;
  if (balance < 3000) return annualPerformance;
  return (balance + Math.min(Math.max(annualPerformance, annualExpense), 5 * balance)) / 2;
}

interface LineComputation {
  units: number;
  base: number | null;
  value: number | null;
  fee: number;
  trace: string[];
}

function validateLineInput(input: FeeLineInput, definition: FeeDefinition): number {
  const quantity = input.quantity ?? 1;
  check(
    Number.isInteger(quantity) && quantity >= 1 && quantity <= 100000,
    'Anzahl muss eine positive ganze Zahl sein.',
  );
  check(
    input.matter.trim().length > 0 && input.matter.length <= 160,
    'Angelegenheit / Zeitraum fehlt.',
  );
  check(
    input.justification.trim().length >= 10 && input.justification.length <= 4000,
    'Wert, Rahmenwahl und Voraussetzungen nachvollziehbar begründen (mind. 10 Zeichen).',
  );
  feeNumber(input.rate, 'Gebührensatz', 1e7);
  if (definition.kind !== 'EXTERNAL')
    check(
      input.rate >= definition.min && input.rate <= definition.max,
      `Satz außerhalb des Rahmens ${definition.min}–${definition.max}.`,
    );
  return quantity;
}

function valueTableFee(
  input: FeeLineInput,
  definition: FeeDefinition,
  value: number,
  trace: string[],
): { base: number; value: number } {
  if (definition.table !== 'D' && definition.table !== 'Da') {
    return { base: fullFeeCents(definition.table!, value), value };
  }
  const area = feeNumber(input.weightedHectares ?? NaN, 'Gewichtete Betriebsfläche', 1e7);
  let base = fullFeeCents('Da', area);
  trace.push(`D a: ${area} gewichtete ha → ${base} Cent.`);
  if (definition.table === 'Da') return { base, value };

  const adjustedValue = definition.id.startsWith('39-3-')
    ? Math.min(value, 100000) + Math.max(value - 100000, 0) / 2
    : value;
  const tableBFee = fullFeeCents('Db', adjustedValue);
  trace.push(`D b: ${adjustedValue} Euro → ${tableBFee} Cent; Summe D a + D b.`);
  base += tableBFee;
  return { base, value: adjustedValue };
}

function calculateValueLine(
  input: FeeLineInput,
  definition: FeeDefinition,
  quantity: number,
): LineComputation {
  if (definition.unit === 'Angelegenheit')
    check(
      quantity === 1,
      'Wertgebühr je Angelegenheit einmal erfassen; getrennte Gegenstände einzeln dokumentieren.',
    );
  const raw = input.rawValue ?? NaN;
  feeNumber(definition.valueSign === 'NONNEGATIVE' ? raw : Math.abs(raw), 'Berechnungsgrundlage');
  const converted = definition.valueSign === 'ABSOLUTE' ? Math.abs(raw) : raw;
  const minimum =
    definition.id === '24-1-10' && input.nonNaturalPerson ? 25000 : definition.minimumValue;
  const initialValue = Math.max(minimum, converted * definition.valueMultiplier);
  const trace: string[] = [];
  if (definition.valueSign === 'ABSOLUTE')
    trace.push(`Gewinn / Verlust ${raw}: absoluter Betrag ${converted}.`);
  trace.push(
    `Grundlage ${converted} × ${definition.valueMultiplier}; Mindestwert ${minimum}; Gegenstandswert ${initialValue}.`,
  );
  const table = valueTableFee(input, definition, initialValue, trace);
  let fee = Math.round((table.base * input.rate) / definition.denominator);
  if (input.consumerFirstConsultation) {
    check(definition.id === '21-1', 'Verbraucher-Erstberatungsgrenze nur bei § 21 Abs. 1.');
    fee = Math.min(fee, 19000);
    trace.push('Erstes Beratungsgespräch eines Verbrauchers: höchstens 190 Euro.');
  }
  trace.push(`${table.base} Cent × ${input.rate}/${definition.denominator}, auf Cent gerundet.`);
  return { units: quantity, base: table.base, value: table.value, fee: fee * quantity, trace };
}

function calculateTimeLine(input: FeeLineInput, quantity: number): LineComputation {
  const minutes = feeNumber(input.minutes ?? NaN, 'Minuten', 1e6);
  check(
    minutes > 0 && quantity === 1,
    'Zeitgebühr: Minuten > 0, Anzahl 1; Minuten derselben Tätigkeit zusammenfassen.',
  );
  const units = Math.ceil(minutes / 15);
  return {
    units,
    base: null,
    value: null,
    fee: cents(input.rate) * units,
    trace: [`${minutes} Minuten → ${units} angefangene Viertelstunden × ${input.rate} Euro.`],
  };
}

function calculateAmountLine(
  input: FeeLineInput,
  definition: FeeDefinition,
  quantity: number,
): LineComputation {
  if (definition.id === '23-2-3')
    check(quantity === 1, 'Reine Kassenabmeldung: nur eine Gebühr unabhängig von Anzahl.');
  return {
    units: quantity,
    base: null,
    value: null,
    fee: cents(input.rate) * quantity,
    trace: [],
  };
}

function calculateExternalLine(input: FeeLineInput, quantity: number): LineComputation {
  check(quantity === 1, 'Manuelle Berechnung einmal als Gesamtbetrag erfassen.');
  return {
    units: quantity,
    base: null,
    value: null,
    fee: cents(
      feeNumber(input.manualAmount ?? NaN, 'Extern / vereinbart ermittelter Nettobetrag', 1e7),
    ),
    trace: [
      'Manuell dokumentierter Betrag; keine automatische Prüfung des RVG / der Vereinbarung / Analogie.',
    ],
  };
}

function computeLine(
  input: FeeLineInput,
  definition: FeeDefinition,
  quantity: number,
): LineComputation {
  if (definition.kind === 'VALUE') return calculateValueLine(input, definition, quantity);
  if (definition.kind === 'TIME') return calculateTimeLine(input, quantity);
  if (definition.kind === 'AMOUNT') return calculateAmountLine(input, definition, quantity);
  return calculateExternalLine(input, quantity);
}

function calculateLine(input: FeeLineInput, definition: FeeDefinition): FeeCalculatedLine {
  const quantity = validateLineInput(input, definition);
  const calculation = computeLine(input, definition, quantity);
  const fee = calculation.fee;
  check(Number.isSafeInteger(fee) && fee <= 9_999_999_999, 'Gebührenbetrag zu hoch.');
  return {
    id: input.id,
    matter: input.matter.trim(),
    feeId: definition.id,
    description: definition.label,
    provision: definition.provision,
    source: definition.source,
    baseFeeCents: calculation.base,
    value: calculation.value,
    rate: input.rate,
    denominator: definition.denominator,
    quantity: calculation.units,
    beforeCreditCents: fee,
    creditCents: 0,
    netCents: fee,
    trace: calculation.trace,
    manual: definition.kind === 'EXTERNAL',
  };
}

/** Narrow RVG reference only: VV 7000 via § 17 StBVV. Inputs are the eligible
 * pages/files, AFTER the statutory entitlement/100-page threshold assessment. */
export function documentExpenseCents(bw: number, color: number): number {
  for (const n of [bw, color])
    check(Number.isInteger(n) && n >= 0 && n <= 100000, 'Ungültige Seitenzahl.');
  return (
    Math.min(bw, 50) * 50 +
    Math.max(0, bw - 50) * 15 +
    Math.min(color, 50) * 100 +
    Math.max(0, color - 50) * 30
  );
}

function validateCalculationInput(input: FeeCalculationInput): void {
  check(
    input.lawVersion === STBVV_VERSION && input.currentLawConfirmed === true,
    'Aktuellen Rechtsstand (§ 41) ausdrücklich bestätigen. Historische Berechnungen werden nicht unterstützt.',
  );
  check(
    input.matterReviewConfirmed === true,
    'Abgeltung, dieselbe Angelegenheit, Gegenstandswerte und Anrechnungen fachlich prüfen und bestätigen.',
  );
  check(
    Array.isArray(input.lines) && input.lines.length > 0 && input.lines.length <= 100,
    '1–100 Gebührenpositionen erforderlich.',
  );
  check(Array.isArray(input.expenses) && input.expenses.length <= 100, 'Zu viele Auslagen.');
}

function calculateUniqueLine(
  input: FeeLineInput,
  ids: Set<string>,
  occurrences: Set<string>,
): FeeCalculatedLine {
  check(
    typeof input.id === 'string' && input.id.length > 0 && !ids.has(input.id),
    'Positionskennungen müssen eindeutig sein.',
  );
  ids.add(input.id);
  const definition = STBVV_CATALOG.find((entry) => entry.id === input.feeId);
  check(definition, 'Unbekannter Gebührentatbestand.');
  const occurrence = `${input.matter.trim()}:${input.feeId}`;
  check(!occurrences.has(occurrence), 'Dieselbe Gebühr je Angelegenheit einmal erfassen (§ 12).');
  occurrences.add(occurrence);
  return calculateLine(input, definition);
}

function calculateFeeLines(inputs: FeeLineInput[], ids: Set<string>): FeeCalculatedLine[] {
  const occurrences = new Set<string>();
  return inputs.map((input) => calculateUniqueLine(input, ids, occurrences));
}

function groupLinesByMatter(lines: FeeCalculatedLine[]): Map<string, FeeCalculatedLine[]> {
  const byMatter = new Map<string, FeeCalculatedLine[]>();
  for (const line of lines) {
    byMatter.set(line.matter, [...(byMatter.get(line.matter) ?? []), line]);
  }
  return byMatter;
}

function includesFee(group: FeeCalculatedLine[], feeId: string): boolean {
  return group.some((line) => line.feeId === feeId);
}

function validateMatterGroup(group: FeeCalculatedLine[]): void {
  const has = (feeId: string) => includesFee(group, feeId);
  check(
    group.filter((line) => line.feeId.startsWith('23-1-')).length <= 1,
    '§ 23 Abs. 1: gleicher Gegenstand nur eine Tätigkeit mit höchstem oberen Rahmen.',
  );
  check(
    !(has('24-1-7') && ['33-1', '33-3', '33-4', '39-2-1', '39-2-2', '39-2-3'].some(has)),
    'USt-Voranmeldung ist mit der gewählten Buchführung abgegolten.',
  );
  check(
    !(has('24-1-15') && ['34-2', '34-3', '34-4'].some(has)),
    'Lohnsteuer-Anmeldung ist mit der Lohnabrechnung abgegolten.',
  );
  check(
    !has('36-2-1') || has('36-2-1zeit'),
    '§ 36 Abs. 2 Nr. 1: zusätzliche Zeitgebühr gesondert erfassen.',
  );
  check(
    !has('36-2-1zeit') || has('36-2-1'),
    'Zusätzliche Prüfungszeit erfordert die zugehörige Wertgebühr.',
  );
}

function applyMinimumReportCredit(group: FeeCalculatedLine[]): void {
  const minimum = group.find((line) => line.feeId === '24-1-4');
  const report = group.find((line) => line.feeId === '24-5-5');
  if (!minimum || !report) return;
  minimum.creditCents = Math.min(report.netCents, Math.round(minimum.beforeCreditCents / 2));
  minimum.netCents -= minimum.creditCents;
  minimum.trace.push(`§ 24 Abs. 2: Mindeststeuerbericht angerechnet ${minimum.creditCents} Cent.`);
}

function applyMatterRules(byMatter: Map<string, FeeCalculatedLine[]>): void {
  for (const group of byMatter.values()) {
    validateMatterGroup(group);
    applyMinimumReportCredit(group);
  }
}

function applyExplicitCredit(
  input: FeeLineInput,
  lines: FeeCalculatedLine[],
  usedCredits: Set<string>,
): void {
  if (!input.creditFromLineId) return;
  const target = lines.find((line) => line.id === input.id)!;
  const source = lines.find((line) => line.id === input.creditFromLineId);
  check(
    source?.feeId === '21-1' && source.id !== target.id && !usedCredits.has(source.id),
    'Nur einmalige Beratungsanrechnung aus § 21 Abs. 1 möglich.',
  );
  usedCredits.add(source.id);
  const amount = Math.min(source.netCents, target.netCents);
  target.creditCents += amount;
  target.netCents -= amount;
  target.trace.push(`Beratung ${source.id} nach § 21 Abs. 1 angerechnet: ${amount} Cent.`);
}

function applyExplicitCredits(inputs: FeeLineInput[], lines: FeeCalculatedLine[]): void {
  const usedCredits = new Set<string>();
  for (const input of inputs) applyExplicitCredit(input, lines, usedCredits);
}

function validateExpense(
  expense: FeeExpenseInput,
  ids: Set<string>,
  byMatter: Map<string, FeeCalculatedLine[]>,
  expenseKeys: Set<string>,
): void {
  check(!ids.has(expense.id) && expense.id.length > 0, 'Auslagenkennung muss eindeutig sein.');
  ids.add(expense.id);
  check(
    byMatter.has(expense.matter) && expense.justification.trim().length >= 10,
    'Auslage erfordert eine vorhandene Angelegenheit und Nachweis / Begründung.',
  );
  const key = `${expense.matter}:${expense.kind.startsWith('POST_') ? 'POST' : expense.kind}`;
  const repeatable = ['ACTUAL', 'TRAVEL_KM', 'ABSENCE'].includes(expense.kind);
  if (!repeatable)
    check(
      !expenseKeys.has(key),
      'Pauschale je Angelegenheit nur einmal; tatsächliche Postkosten und Pauschale nicht kombinieren.',
    );
  expenseKeys.add(key);
}

function absenceExpenseCents(expense: FeeExpenseInput): number {
  const hours = feeNumber(expense.hours ?? NaN, 'Abwesenheitsstunden', 24);
  check(hours > 0, 'Abwesenheitszeit fehlt.');
  const base = hours <= 4 ? 3000 : hours <= 8 ? 5000 : 8000;
  return base * (expense.foreignUplift ? 1.5 : 1);
}

function electronicDocumentExpenseCents(expense: FeeExpenseInput): number {
  check(
    Number.isInteger(expense.files) && expense.files! >= 1 && expense.files! <= 100000,
    'Dateianzahl fehlt.',
  );
  return Math.max(
    Math.min(expense.files! * 150, 500),
    feeNumber(expense.scanEquivalentCents ?? 0, 'Scanäquivalent in Cent', 1e7),
  );
}

function expenseNetCents(
  expense: FeeExpenseInput,
  byMatter: Map<string, FeeCalculatedLine[]>,
): number {
  switch (expense.kind) {
    case 'POST_PERCENT':
      return Math.min(
        2000,
        Math.round(
          byMatter.get(expense.matter)!.reduce((sum, line) => sum + line.netCents, 0) * 0.2,
        ),
      );
    case 'POST_ACTUAL':
    case 'ACTUAL':
      return cents(feeNumber(expense.amount ?? NaN, 'Tatsächliche Auslage', 1e7));
    case 'DOCUMENTS':
      return documentExpenseCents(expense.pagesBw ?? 0, expense.pagesColor ?? 0);
    case 'ELECTRONIC_DOCUMENTS':
      return electronicDocumentExpenseCents(expense);
    case 'TRAVEL_KM':
      return cents(feeNumber(expense.km ?? NaN, 'Kilometer', 100000) * 0.42);
    case 'ABSENCE':
      return absenceExpenseCents(expense);
    default:
      throw new FeeInputError('Unbekannte Auslagenart.');
  }
}

function calculateExpense(
  expense: FeeExpenseInput,
  ids: Set<string>,
  byMatter: Map<string, FeeCalculatedLine[]>,
  expenseKeys: Set<string>,
): { id: string; matter: string; description: string; netCents: number } {
  validateExpense(expense, ids, byMatter, expenseKeys);
  return {
    id: expense.id,
    matter: expense.matter,
    description: `${expense.kind} · ${expense.justification}`,
    netCents: expenseNetCents(expense, byMatter),
  };
}

function calculateExpenses(
  inputs: FeeExpenseInput[],
  ids: Set<string>,
  byMatter: Map<string, FeeCalculatedLine[]>,
): Array<{ id: string; matter: string; description: string; netCents: number }> {
  const expenseKeys = new Set<string>();
  return inputs.map((expense) => calculateExpense(expense, ids, byMatter, expenseKeys));
}

function validateVat(input: FeeCalculationInput): void {
  check(input.vatRate === 0 || input.vatRate === 19, 'Umsatzsteuer: 0 oder 19 Prozent wählen.');
  check(
    input.vatRate !== 0 || (input.vatExemptionReason?.trim().length ?? 0) >= 5,
    '0 % erfordert einen dokumentierten Befreiungsgrund.',
  );
}

function calculationWarnings(lines: FeeCalculatedLine[]): string[] {
  const warnings = [
    'Ungeprüfter fachlicher Entwurf: keine automatische Angemessenheits- oder Rechtsfreigabe.',
    'Mehrere Auftraggeber bewirken nach § 6 keinen automatischen RVG-Zuschlag.',
    '§§ 10, 12: weitere Gegenstände/Teilwerte, bereits entstandene Gebühren und frühere Anrechnungen außerhalb dieser Kalkulation separat prüfen.',
    '§§ 17–20: Anspruch auf Auslagen, Seitenfreigrenzen, Verteilung auf mehrere Angelegenheiten und Sitzverlegung müssen dokumentiert sein.',
  ];
  if (lines.some((line) => line.manual)) {
    warnings.push(
      'Manuelle Positionen enthalten ungeprüfte externe Berechnungen; RVG nur über explizite Verweise.',
    );
  }
  return warnings;
}

export function calculateStbvv(input: FeeCalculationInput): FeeCalculation {
  validateCalculationInput(input);
  const ids = new Set<string>();
  const lines = calculateFeeLines(input.lines, ids);
  const byMatter = groupLinesByMatter(lines);
  applyMatterRules(byMatter);
  applyExplicitCredits(input.lines, lines);
  const expenses = calculateExpenses(input.expenses, ids, byMatter);
  validateVat(input);
  const netCents =
    lines.reduce((sum, line) => sum + line.netCents, 0) +
    expenses.reduce((sum, expense) => sum + expense.netCents, 0);
  check(Number.isSafeInteger(netCents) && netCents <= 9_999_999_999, 'Gesamtbetrag zu hoch.');
  const vatCents = Math.round((netCents * input.vatRate) / 100);
  return {
    lawVersion: STBVV_VERSION,
    tableVersion: data.version,
    lines,
    expenses,
    netCents,
    vatCents,
    grossCents: netCents + vatCents,
    warnings: calculationWarnings(lines),
  };
}
