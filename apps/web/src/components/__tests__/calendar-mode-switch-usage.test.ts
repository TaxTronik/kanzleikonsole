import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const appRoot = resolve(process.cwd(), 'src/app/staff/(protected)');

describe('Kalender-Ansichtsschalter', () => {
  it('steht in beiden Ansichten am selben Bedienort zur Verfügung', () => {
    const calendar = readFileSync(resolve(appRoot, 'calendar/page.tsx'), 'utf8');
    const deadlines = readFileSync(resolve(appRoot, 'tax-deadlines/page.tsx'), 'utf8');

    expect(calendar).toContain('<CalendarModeSwitch active="calendar" month={currentMonthQs} />');
    expect(deadlines).toContain('<CalendarModeSwitch active="tax-deadlines" month={month} />');
    expect(deadlines).not.toContain('Zurück zum Kanzleikalender');
  });
});
