// Kanzleikalender als Render-Test gegen eine nachgebildete Tenant-Tx (B-08,
// Welle 15) statt Quelltextprüfung der Seite: Monatsabfragen (P-20,
// Europe/Berlin-Grenzen, abgesagte Termine), entschiedene Terminanfragen mit
// Zustellstatus (C4) und der Ansichtsschalter zu /staff/tax-deadlines.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { berlinMonthBoundsUtc } from '@/lib/tax-calendar';
import { clientAccessFilter, optionalClientAccessFilter } from '@/server/auth/client-access-filter';

const ACCESS = { vertraulich: false };
const STAFF_LIST = [{ id: 'staff-1', fullName: 'Erika Muster' }];

const h = vi.hoisted(() => ({
  modules: { taxNotices: true, appointments: true },
  loadDayGroups: vi.fn(),
  loadMail: vi.fn(),
  pills: [] as Array<Record<string, unknown>>,
  decided: [] as Array<Record<string, unknown>>,
  tx: {
    appointment: { findMany: vi.fn() },
    appointmentRequest: { findMany: vi.fn() },
    staffUser: { findMany: vi.fn() },
    vacationRequest: { findMany: vi.fn() },
    absence: { findMany: vi.fn() },
  },
}));

vi.mock('@/server/auth/staff-page', () => ({
  requireStaffPage: vi.fn(async () => ({
    user: { tenantId: 'tenant-1', staffId: 'staff-1', roles: ['STAFF'] },
  })),
}));
vi.mock('@/server/settings/module-page', () => ({
  requireModulePage: vi.fn(async () => h.modules),
}));
vi.mock('@/server/auth/rbac', () => ({ accessibleClientsWhereFor: vi.fn(async () => ACCESS) }));
vi.mock('@/server/tax-deadlines/day-groups', () => ({
  loadTaxDeadlineDayGroupsTx: h.loadDayGroups,
}));
vi.mock('@/server/mail/delivery-status', () => ({ loadMailDeliveryTx: h.loadMail }));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(h.tx)),
}));
vi.mock('../new-appointment-dialog', () => ({ NewAppointmentDialog: () => null }));
vi.mock('../request-decision', () => ({ RequestDecision: () => null }));
vi.mock('../appointment-pills', () => ({
  AppointmentPills: (props: Record<string, unknown>) => {
    h.pills.push(props);
    return null;
  },
}));
vi.mock('../decided-requests', () => ({
  DecidedRequests: (props: Record<string, unknown>) => {
    h.decided.push(props);
    return null;
  },
}));

import CalendarPage from '../page';

const NOW = new Date('2026-03-20T09:00:00.000Z');
const appointment = {
  id: 'appt-1',
  title: 'Jahresgespräch',
  status: 'CANCELLED',
  // 10.03. 00:30 Berlin (MEZ) liegt am Vortag in UTC.
  startsAt: new Date('2026-03-09T23:30:00.000Z'),
  endsAt: new Date('2026-03-10T00:30:00.000Z'),
  owner: { id: 'staff-1', fullName: 'Erika Muster' },
  client: { id: 'client-1', name: 'Muster GmbH' },
};
const decidedRequest = {
  id: 'request-1',
  subject: 'Rückfrage',
  status: 'ACCEPTED',
  decidedAt: new Date('2026-03-19T08:00:00.000Z'),
  client: { name: 'Muster GmbH' },
};
const mail = [{ purpose: 'appointment-confirmed', state: 'delivered' }];

async function render(month = '2026-03'): Promise<string> {
  return renderToStaticMarkup(
    await CalendarPage({ searchParams: Promise.resolve({ month }) as never }),
  );
}

function requestCall(status: unknown) {
  return h.tx.appointmentRequest.findMany.mock.calls
    .map(([args]) => args as { where: Record<string, unknown> })
    .find((args) => JSON.stringify(args.where.status) === JSON.stringify(status));
}

beforeAll(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
});
afterAll(() => {
  vi.useRealTimers();
});
beforeEach(() => {
  vi.clearAllMocks();
  h.modules = { taxNotices: true, appointments: true };
  h.pills.length = 0;
  h.decided.length = 0;
  h.loadDayGroups.mockResolvedValue(new Map());
  h.loadMail.mockResolvedValue(new Map([['request-1', mail]]));
  h.tx.appointment.findMany.mockResolvedValue([appointment]);
  h.tx.appointmentRequest.findMany.mockImplementation(async ({ where }) =>
    where.status === 'PENDING' ? [] : [decidedRequest],
  );
  h.tx.staffUser.findMany.mockResolvedValue(STAFF_LIST);
  h.tx.vacationRequest.findMany.mockResolvedValue([]);
  h.tx.absence.findMany.mockResolvedValue([]);
});

describe('Kalender-Steuertermine (P-20)', () => {
  it('aggregiert über den gemeinsamen Tageslader auf UTC-Kalendertagen, ohne eigene Steuertermin-Abfrage', async () => {
    // Die nachgebildete Tx hat kein taxDeadline: eine eigene Abfrage der Seite schlüge fehl.
    await render();
    expect(h.loadDayGroups).toHaveBeenCalledOnce();
    expect(h.loadDayGroups).toHaveBeenCalledWith(h.tx, {
      dueDate: {
        gte: new Date(Date.UTC(2026, 2, 1)),
        lte: new Date(Date.UTC(2026, 2, 31, 23, 59, 59, 999)),
      },
      ...clientAccessFilter(ACCESS),
    });
  });
});

describe('Kalender-Termine: Europe/Berlin-Monatsgrenzen', () => {
  it('wendet die halb-offenen Berlin-Grenzen auf die Terminabfrage an und lädt Absagen mit', async () => {
    await render();
    const { start, endExclusive } = berlinMonthBoundsUtc(2026, 2);
    const [args] = h.tx.appointment.findMany.mock.calls[0]!;
    expect(args.where).toEqual({
      startsAt: { lt: endExclusive },
      endsAt: { gte: start },
      ...optionalClientAccessFilter(ACCESS),
    });
    // Review-Befund C1: kein Statusfilter, abgesagte Termine bleiben sichtbar.
    expect(JSON.stringify(args.where)).not.toContain('CANCELLED');
  });

  it('zeigt Termine am Berlin-Tag als Pillen (höchstens drei je Tag) mit der Bearbeiterauswahl', async () => {
    await render();
    const withAppointment = h.pills.filter((props) => (props.appointments as unknown[]).length > 0);
    expect(withAppointment).toHaveLength(1);
    expect(withAppointment[0]).toMatchObject({
      appointments: [appointment],
      staffOptions: STAFF_LIST,
      limit: 3,
    });
    expect(h.pills.every((props) => props.limit === 3 && props.staffOptions === STAFF_LIST)).toBe(
      true,
    );
  });
});

describe('Entschiedene Terminanfragen (C4)', () => {
  it('lädt die Entscheidungen der letzten 14 Tage mit derselben Mandantensichtbarkeit', async () => {
    await render();
    const decided = requestCall({ in: ['ACCEPTED', 'REJECTED'] });
    expect(decided?.where).toEqual({
      status: { in: ['ACCEPTED', 'REJECTED'] },
      decidedAt: { gte: new Date(NOW.getTime() - 14 * 86_400_000) },
      ...clientAccessFilter(ACCESS),
    });
    expect(requestCall('PENDING')?.where).toEqual({
      status: 'PENDING',
      ...clientAccessFilter(ACCESS),
    });
  });

  it('übernimmt den Zustellstatus der Terminmails je Anfrage', async () => {
    await render();
    expect(h.loadMail).toHaveBeenCalledWith(h.tx, {
      resourceType: 'appointment_request',
      resourceIds: ['request-1'],
    });
    expect(h.decided).toEqual([
      {
        days: 14,
        requests: [
          {
            id: 'request-1',
            subject: 'Rückfrage',
            clientName: 'Muster GmbH',
            status: 'ACCEPTED',
            decidedAt: decidedRequest.decidedAt,
            mail,
          },
        ],
      },
    ]);
  });
});

describe('Kalender-Ansichtsschalter', () => {
  it('steht im Kanzleikalender mit dem angezeigten Monat zur Verfügung', async () => {
    const html = await render('2026-04');
    expect(html).toContain('role="group" aria-label="Kalenderansicht"');
    expect(html).toMatch(/<span class="[^"]*" aria-current="page">Kanzleikalender<\/span>/);
    expect(html).toContain('href="/staff/tax-deadlines?month=2026-04"');
  });

  it('fehlt ohne Steuertermin-Modul', async () => {
    h.modules = { taxNotices: false, appointments: true };
    const html = await render();
    expect(html).not.toContain('aria-label="Kalenderansicht"');
    expect(h.loadDayGroups).not.toHaveBeenCalled();
  });
});
