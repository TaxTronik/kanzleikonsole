// Review-Befund C1: Ein von der Kanzlei abgesagter Termin verschwindet aus den
// bestätigten Terminen des Portals, und die zugehörige Anfrage steht nicht mehr
// als „Bestätigt" da. Eine verschobene Anfrage nennt die aktuelle Startzeit.

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  tx: {
    appointment: { findMany: vi.fn() },
    appointmentRequest: { findMany: vi.fn() },
    clientContact: { findUnique: vi.fn() },
  },
}));

vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@/server/auth/portal', () => ({
  portalAuth: async () => ({
    user: { tenantId: 'tenant-1', contactId: 'contact-1', clientId: 'client-1' },
  }),
}));
vi.mock('@/server/settings/module-page', () => ({ requireModulePage: vi.fn() }));
vi.mock('@/server/settings/portal-features', () => ({
  readPortalFeatures: async () => ({ appointmentRequests: false }),
}));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: async (_ctx: unknown, run: (tx: unknown) => unknown) => run(h.tx),
}));
vi.mock('@taxtronik/config', () => ({ portalBaseUrl: 'https://portal.example.test' }));
vi.mock('@/server/ical/feed', () => ({ signIcalToken: () => 'signed' }));
vi.mock('../staff-options', () => ({ readAppointmentStaffOptionsTx: async () => [] }));
vi.mock('../request-form', () => ({ AppointmentRequestForm: () => null }));
vi.mock('../cancel-request-button', () => ({ CancelRequestButton: () => null }));
vi.mock('../ical-subscribe', () => ({ IcalSubscribe: () => null }));

import PortalAppointmentsPage from '../page';

function request(overrides: Record<string, unknown>) {
  return {
    id: 'request-1',
    subject: 'Jahresgespräch',
    status: 'ACCEPTED',
    createdAt: new Date('2026-10-01T08:00:00.000Z'),
    proposedSlots: [{ startsAt: '2026-10-20T10:00', endsAt: '2026-10-20T11:00' }],
    acceptedSlot: { startsAt: '2026-10-20T10:00', endsAt: '2026-10-20T11:00' },
    rejectionReason: null,
    preferredStaff: null,
    decidedBy: null,
    acceptedAppointment: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.tx.appointment.findMany.mockResolvedValue([]);
  h.tx.clientContact.findUnique.mockResolvedValue({ icalTokenVersion: 1 });
});

describe('Portal-Termine', () => {
  it('lädt nur nicht abgesagte Termine und liest den Stand der angenommenen Termine', async () => {
    h.tx.appointmentRequest.findMany.mockResolvedValue([]);

    await PortalAppointmentsPage();

    expect(h.tx.appointment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ clientId: 'client-1', status: { not: 'CANCELLED' } }),
      }),
    );
    expect(h.tx.appointmentRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          acceptedAppointment: { select: { status: true, startsAt: true } },
        }),
      }),
    );
  });

  it('zeigt die Anfrage eines abgesagten Termins als „Termin abgesagt" ohne Bestätigungszeit', async () => {
    h.tx.appointmentRequest.findMany.mockResolvedValue([
      request({
        acceptedAppointment: { status: 'CANCELLED', startsAt: new Date('2026-10-20T08:00:00Z') },
      }),
    ]);

    const html = renderToStaticMarkup(await PortalAppointmentsPage());

    expect(html).toContain('Termin abgesagt');
    expect(html).not.toContain('Bestätigt für');
    expect(html).not.toMatch(/badge-green[^>]*>.*Bestätigt/);
  });

  it('nennt nach einer Verschiebung die aktuelle Startzeit des Termins', async () => {
    h.tx.appointmentRequest.findMany.mockResolvedValue([
      request({
        // 21.10.2026 14:30 Berlin (CEST) statt des bestätigten Wunschtermins 20.10. 10:00
        acceptedAppointment: { status: 'CONFIRMED', startsAt: new Date('2026-10-21T12:30:00Z') },
      }),
    ]);

    const html = renderToStaticMarkup(await PortalAppointmentsPage());

    expect(html).toContain('Bestätigt für: 21.10.2026, 14:30');
    expect(html).not.toContain('Termin abgesagt');
  });
});
