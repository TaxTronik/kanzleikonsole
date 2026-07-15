import { describe, expect, it } from 'vitest';
import { calendarModeHref } from '../calendar-mode';

describe('calendarModeHref', () => {
  it('wechselt am selben Ort zwischen Kanzleikalender und Steuerterminen', () => {
    expect(calendarModeHref('calendar')).toBe('/staff/calendar');
    expect(calendarModeHref('tax-deadlines')).toBe('/staff/tax-deadlines');
  });

  it('behält den ausgewählten Monat beim Ansichtswechsel bei', () => {
    expect(calendarModeHref('calendar', '2026-07')).toBe('/staff/calendar?month=2026-07');
    expect(calendarModeHref('tax-deadlines', '2026-07')).toBe('/staff/tax-deadlines?month=2026-07');
  });
});
