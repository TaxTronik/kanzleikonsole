// Fachkatalog: CLIENT-MANDATE-LIFECYCLE-001, ACCESS-TENANT-RLS-001.
// S-01: the owner client resolves only the tenant of the token's contact; the
// feed itself is read in that tenant's SYSTEM context (route-db.test.ts proves
// the app role and the tenant isolation against PostgreSQL).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const m = vi.hoisted(() => {
  const contactFindFirst = vi.fn();
  const deadlineFindMany = vi.fn();
  const appointmentFindMany = vi.fn();
  const tx = {
    clientContact: { findFirst: contactFindFirst },
    taxDeadline: { findMany: deadlineFindMany },
    appointment: { findMany: appointmentFindMany },
  };
  return {
    verifyIcalToken: vi.fn(),
    buildIcs: vi.fn(),
    ownerFindFirst: vi.fn(),
    contactFindFirst,
    deadlineFindMany,
    appointmentFindMany,
    readBooleanTenantModules: vi.fn(),
    tx,
    withSystemContext: vi.fn(async (_tenantId: string, fn: (value: typeof tx) => unknown) =>
      fn(tx),
    ),
  };
});

vi.mock('@/server/ical/feed', () => ({
  verifyIcalToken: m.verifyIcalToken,
  buildIcs: m.buildIcs,
}));
vi.mock('@/server/db/prisma-owner', () => ({
  prismaOwner: { clientContact: { findFirst: m.ownerFindFirst } },
}));
vi.mock('@taxtronik/db', () => ({ withSystemContext: m.withSystemContext }));
vi.mock('@taxtronik/tax', () => ({ SCHEDULE_LABELS: {} }));
vi.mock('@taxtronik/db/tenant-modules', () => ({
  readBooleanTenantModules: m.readBooleanTenantModules,
}));

import { GET } from '../route';

const request = {} as NextRequest;

function contact(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'tenant-1',
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
  m.ownerFindFirst.mockResolvedValue({ tenantId: 'tenant-1' });
  m.contactFindFirst.mockResolvedValue(contact());
  m.deadlineFindMany.mockResolvedValue([]);
  m.appointmentFindMany.mockResolvedValue([]);
  m.buildIcs.mockReturnValue('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n');
  m.readBooleanTenantModules.mockResolvedValue({
    taxNotices: true,
    appointments: true,
  });
});

async function callRoute(): Promise<Response> {
  return GET(request, { params: Promise.resolve({ token: 'signed-token' }) });
}

describe('portal iCal lifecycle gate', () => {
  it('returns 404 without a tenant context for an unknown or inactive contact', async () => {
    m.ownerFindFirst.mockResolvedValue(null);

    expect((await callRoute()).status).toBe(404);
    expect(m.withSystemContext).not.toHaveBeenCalled();
    expect(m.buildIcs).not.toHaveBeenCalled();
  });

  it('revokes an existing calendar subscription after mandate termination', async () => {
    m.contactFindFirst.mockResolvedValue(
      contact({
        client: {
          name: 'Mandant GmbH',
          allowActive: true,
          anonymizedAt: null,
          mandateEndedAt: new Date('2026-09-01T00:00:00Z'),
        },
      }),
    );
    expect((await callRoute()).status).toBe(404);
    expect(m.readBooleanTenantModules).not.toHaveBeenCalled();
    expect(m.deadlineFindMany).not.toHaveBeenCalled();
    expect(m.appointmentFindMany).not.toHaveBeenCalled();
    expect(m.buildIcs).not.toHaveBeenCalled();
  });
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
    // S-01: the owner reads only the tenant ID, everything else runs in the tenant context.
    expect(m.ownerFindFirst).toHaveBeenCalledWith({
      where: { id: 'contact-1', active: true },
      select: { tenantId: true },
    });
    expect(m.withSystemContext).toHaveBeenCalledTimes(1);
    expect(m.withSystemContext).toHaveBeenCalledWith('tenant-1', expect.any(Function));
    expect(m.contactFindFirst).toHaveBeenCalledWith({
      where: { id: 'contact-1', tenantId: 'tenant-1', active: true },
      select: {
        clientId: true,
        icalTokenVersion: true,
        client: {
          select: { name: true, allowActive: true, anonymizedAt: true, mandateEndedAt: true },
        },
      },
    });
    expect(m.readBooleanTenantModules).toHaveBeenCalledWith(m.tx, 'tenant-1');
    expect(m.deadlineFindMany).toHaveBeenCalledTimes(1);
    expect(m.deadlineFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 'tenant-1', clientId: 'client-1' }),
      }),
    );
    expect(m.appointmentFindMany).toHaveBeenCalledTimes(1);
  });

  it('omits cancelled appointments from the subscribed feed (review finding C1)', async () => {
    m.appointmentFindMany.mockResolvedValue([
      {
        id: 'appointment-1',
        title: 'Jahresgespräch',
        startsAt: new Date('2026-10-20T08:00:00.000Z'),
        endsAt: new Date('2026-10-20T09:00:00.000Z'),
        location: null,
      },
    ]);

    expect((await callRoute()).status).toBe(200);

    expect(m.appointmentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-1',
          clientId: 'client-1',
          status: { not: 'CANCELLED' },
        }),
      }),
    );
    expect(m.buildIcs).toHaveBeenCalledWith(expect.any(String), [
      expect.objectContaining({ uid: 'appt-appointment-1', summary: 'Jahresgespräch' }),
    ]);
  });
});
