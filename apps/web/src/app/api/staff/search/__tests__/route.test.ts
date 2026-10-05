// Fachkatalog: ACCESS-SEARCH-SCOPE-001
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  staffAuth: vi.fn(),
  rateLimit: vi.fn(),
  readModules: vi.fn(),
  clientAccess: vi.fn(),
  withTenantContext: vi.fn(),
  client: vi.fn(),
  request: vi.fn(),
  document: vi.fn(),
  invoice: vi.fn(),
  queryRaw: vi.fn(),
}));

vi.mock('@/server/auth/staff', () => ({ staffAuth: m.staffAuth }));
vi.mock('@/server/rate-limit', () => ({ checkStaffSearchLimit: m.rateLimit }));
vi.mock('@/server/settings/modules', () => ({ readModules: m.readModules }));
vi.mock('@/server/auth/rbac', () => ({ accessibleClientsWhereFor: m.clientAccess }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));

import { GET } from '../route';

// OPEN-Regel eines Nicht-Admins (Form wie accessibleClientsWhereFor).
const access = {
  OR: [{ vertraulich: false }, { responsibilities: { some: { staffId: 'staff-1' } } }],
};

const request = (q = 'muster') =>
  ({ nextUrl: { searchParams: new URLSearchParams({ q }) } }) as never;

/** Aufrufe der Kandidatenfunktion: [Kategorie, Begriff, Blockgröße, Offset]. */
function candidateCalls(): unknown[][] {
  return m.queryRaw.mock.calls
    .filter(([strings]) => (strings as string[]).join('?').includes('staff_search_candidates'))
    .map(([, ...values]) => values);
}

describe('GET /api/staff/search — Modul- und Mandanten-Gates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.staffAuth.mockResolvedValue({
      user: { tenantId: 'tenant-1', staffId: 'staff-1' },
    });
    m.rateLimit.mockResolvedValue({ ok: true });
    m.clientAccess.mockResolvedValue(access);
    m.client.mockResolvedValue([]);
    m.request.mockResolvedValue([]);
    m.document.mockResolvedValue([]);
    m.invoice.mockResolvedValue([]);
    // Stufe 1: je Kategorie eine Kandidaten-ID; KB-Abfrage leer.
    m.queryRaw.mockImplementation(async (strings: string[], ...values: unknown[]) =>
      strings.join('?').includes('staff_search_candidates') ? [{ id: `${values[0]}-1` }] : [],
    );
    m.withTenantContext.mockImplementation(async (_ctx, fn) =>
      fn({
        client: { findMany: m.client },
        request: { findMany: m.request },
        document: { findMany: m.document },
        invoice: { findMany: m.invoice },
        $queryRaw: m.queryRaw,
      }),
    );
  });

  it('fragt Rechnungen bei invoiceMode=OFF nicht ab', async () => {
    m.readModules.mockResolvedValue({ invoiceMode: 'OFF', knowledge: false });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(m.invoice).not.toHaveBeenCalled();
    expect(candidateCalls().map(([kind]) => kind)).not.toContain('invoice');
    await expect(response.json()).resolves.toEqual({ count: 0, results: [] });
  });

  it('lädt nur Kandidaten-IDs, mit Sichtbarkeitsregel und unverändertem Suchfilter', async () => {
    m.readModules.mockResolvedValue({ invoiceMode: 'EXTERNAL', knowledge: false });

    await GET(request('50%_x'));

    // Stufe 1 bekommt den rohen Begriff; das Escaping übernimmt die Funktion.
    expect(candidateCalls()).toEqual(
      ['client', 'request', 'document', 'invoice'].map((kind) => [kind, '50%_x', 200, 0]),
    );
    const contains = { contains: '50\\%\\_x', mode: 'insensitive' };
    expect(m.client.mock.calls[0]![0].where).toEqual({
      id: { in: ['client-1'] },
      AND: [
        access,
        {
          OR: [
            { name: contains },
            { datevNo: contains },
            { addisonNo: contains },
            { vatId: contains },
          ],
        },
      ],
    });
    expect(m.request.mock.calls[0]![0].where).toEqual({
      id: { in: ['request-1'] },
      client: access,
      OR: [{ title: contains }, { description: contains }],
    });
    expect(m.invoice.mock.calls[0]![0].where).toEqual({
      id: { in: ['invoice-1'] },
      client: access,
      OR: [{ number: contains }, { subject: contains }],
    });
    expect(m.document.mock.calls[0]![0].where).toEqual({
      id: { in: ['document-1'] },
      title: contains,
      deletedAt: null,
      OR: [{ clientId: null }, { client: access }],
    });
    for (const query of [m.client, m.request, m.document, m.invoice]) {
      expect(query.mock.calls[0]![0].take).toBe(5);
    }
    // Keine NOT-IN-Liste gesperrter Mandanten (P-09).
    expect(JSON.stringify(m.client.mock.calls)).not.toContain('notIn');
  });

  it('hängt für Admin/Partner (Regel `{}`) keinen Mandantenfilter an', async () => {
    m.readModules.mockResolvedValue({ invoiceMode: 'EXTERNAL', knowledge: false });
    m.clientAccess.mockResolvedValue({});

    await GET(request());

    for (const query of [m.request, m.invoice, m.document]) {
      const where = query.mock.calls[0]![0].where;
      expect(where).not.toHaveProperty('client');
      expect(where).not.toHaveProperty('clientId');
    }
    expect(m.document.mock.calls[0]![0].where).not.toHaveProperty('OR');
  });

  it('fragt ohne Kandidaten keine Detaildaten ab', async () => {
    m.readModules.mockResolvedValue({ invoiceMode: 'EXTERNAL', knowledge: false });
    m.queryRaw.mockResolvedValue([]);

    const response = await GET(request());

    for (const query of [m.client, m.request, m.document, m.invoice]) {
      expect(query).not.toHaveBeenCalled();
    }
    await expect(response.json()).resolves.toEqual({ count: 0, results: [] });
  });
});
