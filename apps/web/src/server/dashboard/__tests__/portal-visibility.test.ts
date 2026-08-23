import { describe, expect, it } from 'vitest';
import { portalDashboardVisibility } from '../portal-visibility';

describe('Portal-Dashboard-Modulsicht', () => {
  it.each([
    [
      { forms: false, invoiceMode: 'OFF' as const },
      { forms: false, invoices: false },
    ],
    [
      { forms: true, invoiceMode: 'IN_APP' as const },
      { forms: true, invoices: true },
    ],
    [
      { forms: true, invoiceMode: 'EXTERNAL' as const },
      { forms: true, invoices: true },
    ],
  ])('leitet Query- und Abschnittssicht aus den Modulwerten ab', (modules, expected) => {
    expect(portalDashboardVisibility(modules)).toEqual(expected);
  });
});
