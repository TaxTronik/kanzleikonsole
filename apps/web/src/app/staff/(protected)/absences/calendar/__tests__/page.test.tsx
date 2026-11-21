import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AbsencesCalendarPage from '../page';

const db = vi.hoisted(() => ({
  staffUser: { findMany: vi.fn() },
  vacationRequest: { findMany: vi.fn() },
  absence: { findMany: vi.fn() },
}));
vi.mock('@/server/auth/staff-page', () => ({
  requireStaffPage: async () => ({ user: { tenantId: 'kanzlei', staffId: 'ich' } }),
}));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: (_ctx: unknown, run: (tx: typeof db) => unknown) => run(db),
}));
afterEach(() => vi.useRealTimers());

// Fachkatalog: ABSENCE-CALENDAR-001
describe('Wandkalender der Kanzlei', () => {
  it.each([
    [
      '2026-07-05T21:59:59.999Z',
      '2026-06-29',
      '2026-07-12',
      '29.06.2026',
      '05.07.2026',
      '06.07.2026',
    ],
    [
      '2026-07-05T22:00:00.000Z',
      '2026-07-06',
      '2026-07-19',
      '06.07.2026',
      '06.07.2026',
      '07.07.2026',
    ],
  ])(
    'verwendet denselben Berliner Stichtag für Wochenfenster und offene Abwesenheit (%s)',
    async (instant, from, until, first, lastAbsent, next) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(instant));
      db.staffUser.findMany.mockResolvedValue([{ id: 'team', fullName: 'Testperson' }]);
      db.vacationRequest.findMany.mockResolvedValue([]);
      db.absence.findMany.mockResolvedValue([
        { staffId: 'team', startDate: new Date('2026-07-03'), endDate: null },
      ]);
      const page = await AbsencesCalendarPage({ searchParams: Promise.resolve({ weeks: '2' }) });
      const html = renderToStaticMarkup(page);
      expect(html).toContain(first + ' – ');
      expect(html).toContain('title="Testperson · ' + lastAbsent + ' · abw."');
      expect(html).not.toContain('title="Testperson · ' + next + ' · abw."');
      expect(db.absence.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            startDate: { lte: new Date(until) },
            OR: [{ endDate: null }, { endDate: { gte: new Date(from) } }],
          }),
        }),
      );
    },
  );
});
