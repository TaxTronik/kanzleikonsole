import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({
  verifyIcalToken: vi.fn(),
  buildIcs: vi.fn(),
  contactFindFirst: vi.fn(),
  deadlineFindMany: vi.fn(),
  appointmentFindMany: vi.fn(),
}));

vi.mock('@/server/ical/feed', () => ({
  verifyIcalToken: m.verifyIcalToken,
  buildIcs: m.buildIcs,
}));
vi.mock('@/server/db/prisma-owner', () => ({
  prismaOwner: {
    clientContact: { findFirst: m.contactFindFirst },
    taxDeadline: { findMany: m.deadlineFindMany },
    appointment: { findMany: m.appointmentFindMany },
  },
}));
vi.mock('@taxtronik/tax', () => ({ SCHEDULE_LABELS: {} }));

import { GET } from '../route';

const request = {} as NextRequest;

function contact(overrides: Record<string, unknown> = {}) {
  return {
    clientId: 'client-1',
    icalTokenVersion: 3,
    client: {
      name: 'Mandant GmbH',
      allowActive: true,
      anonymizedAt: null,
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.verifyIcalToken.mockReturnValue({ contactId: 'contact-1', version: 3 });
  m.contactFindFirst.mockResolvedValue(contact());
  m.deadlineFindMany.mockResolvedValue([]);
  m.appointmentFindMany.mockResolvedValue([]);
  m.buildIcs.mockReturnValue('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n');
});

async function callRoute(): Promise<Response> {
  return GET(request, { params: Promise.resolve({ token: 'signed-token' }) });
}

describe('portal iCal lifecycle gate', () => {
  it('returns 404 when GwG/client activation is blocked', async () => {
    m.contactFindFirst.mockResolvedValue(
      contact({
        client: { name: 'Mandant GmbH', allowActive: false, anonymizedAt: null },
      }),
    );

    const response = await callRoute();

    expect(response.status).toBe(404);
    expect(m.deadlineFindMany).not.toHaveBeenCalled();
    expect(m.appointmentFindMany).not.toHaveBeenCalled();
  });

  it('returns 404 for an anonymized client', async () => {
    m.contactFindFirst.mockResolvedValue(
      contact({
        client: {
          name: 'Anonymisiert',
          allowActive: true,
          anonymizedAt: new Date('2026-07-01T00:00:00.000Z'),
        },
      }),
    );

    const response = await callRoute();

    expect(response.status).toBe(404);
    expect(m.buildIcs).not.toHaveBeenCalled();
  });

  it('serves a version-matching feed only for an active client', async () => {
    const response = await callRoute();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/calendar');
    expect(m.contactFindFirst).toHaveBeenCalledWith({
      where: { id: 'contact-1', active: true },
      select: {
        clientId: true,
        icalTokenVersion: true,
        client: { select: { name: true, allowActive: true, anonymizedAt: true } },
      },
    });
    expect(m.deadlineFindMany).toHaveBeenCalledTimes(1);
    expect(m.appointmentFindMany).toHaveBeenCalledTimes(1);
  });
});
