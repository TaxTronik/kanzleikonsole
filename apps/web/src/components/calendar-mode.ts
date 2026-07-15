export type CalendarMode = 'calendar' | 'tax-deadlines';

export function calendarModeHref(mode: CalendarMode, month?: string): string {
  const path = mode === 'calendar' ? '/staff/calendar' : '/staff/tax-deadlines';
  return month ? `${path}?month=${encodeURIComponent(month)}` : path;
}
