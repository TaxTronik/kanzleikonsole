// Review-Befund C1: Termine werden abgesagt statt gelöscht. Abgesagte Termine
// gehören nicht in die anstehenden Termine des Dashboards.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { RenderCtx } from '../widgets/_shared';
import { CalendarWidget } from '../widgets/calendar';

describe('Dashboard-Kalender', () => {
  it('lädt nur nicht abgesagte Termine und behält den Mandantenzugriffsfilter', async () => {
    const tx = {
      appointment: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'appointment-1',
            title: 'Jahresgespräch',
            startsAt: new Date('2026-10-20T08:00:00.000Z'),
            endsAt: new Date('2026-10-20T09:00:00.000Z'),
            location: null,
            status: 'CONFIRMED',
            owner: { fullName: 'Erika Beispiel' },
            client: null,
          },
        ]),
      },
      taxDeadline: { findMany: vi.fn() },
    };
    const clientAccess = { id: { in: ['client-1'] } };

    const node = await CalendarWidget({
      tx: tx as unknown as RenderCtx['tx'],
      staffId: 'staff-1',
      modules: { appointments: true, taxNotices: false } as RenderCtx['modules'],
      clientAccess,
    });

    expect(tx.appointment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { not: 'CANCELLED' },
          OR: [{ clientId: null }, { client: clientAccess }],
        }),
      }),
    );
    expect(tx.taxDeadline.findMany).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(<>{node}</>)).toContain('Jahresgespräch');
  });
});
