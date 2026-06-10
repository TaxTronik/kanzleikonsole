import { describe, it, expect } from 'vitest';
import { formatInvoiceNumber, isValidInvoiceTransition } from '../number';

describe('formatInvoiceNumber', () => {
  it('formatiert YYYY-NNNN mit Padding', () => {
    expect(formatInvoiceNumber(2026, 1)).toBe('2026-0001');
    expect(formatInvoiceNumber(2026, 42)).toBe('2026-0042');
  });

  it('wächst über 9999 hinaus ohne Kollision', () => {
    expect(formatInvoiceNumber(2026, 12345)).toBe('2026-12345');
  });
});

describe('isValidInvoiceTransition (MUSS der DB-Trigger-Matrix entsprechen)', () => {
  it.each([
    ['DRAFT', 'SENT', true],
    ['DRAFT', 'CANCELLED', true],
    ['DRAFT', 'PAID', false],
    ['SENT', 'PAID', true],
    ['SENT', 'OVERDUE', true],
    ['SENT', 'CANCELLED', true],
    ['SENT', 'DRAFT', false],
    ['OVERDUE', 'PAID', true],
    ['OVERDUE', 'CANCELLED', true],
    ['OVERDUE', 'SENT', false],
    ['PAID', 'CANCELLED', false],
    ['PAID', 'SENT', false],
    ['CANCELLED', 'SENT', false],
    ['CANCELLED', 'PAID', false],
  ] as const)('%s → %s = %s', (from, to, ok) => {
    expect(isValidInvoiceTransition(from, to)).toBe(ok);
  });
});
