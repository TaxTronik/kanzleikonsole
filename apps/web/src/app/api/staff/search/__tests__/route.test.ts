import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  staffAuth: vi.fn(),
  rateLimit: vi.fn(),
  readModules: vi.fn(),
  deniedIds: vi.fn(),
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
vi.mock('@/server/auth/rbac', () => ({ inaccessibleClientIdsFor: m.deniedIds }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));

import { GET } from '../route';

const request = (q = 'muster') =>
  ({ nextUrl: { searchParams: new URLSearchParams({ q }) } }) as never;

describe('GET /api/staff/search — Modul- und Mandanten-Gates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.staffAuth.mockResolvedValue({
      user: { tenantId: 'tenant-1', staffId: 'staff-1' },
    });
    m.rateLimit.mockResolvedValue({ ok: true });
    m.deniedIds.mockResolvedValue(['client-denied']);
    m.client.mockResolvedValue([]);
    m.request.mockResolvedValue([]);
    m.document.mockResolvedValue([]);
    m.invoice.mockResolvedValue([]);
    m.queryRaw.mockResolvedValue([]);
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
    await expect(response.json()).resolves.toEqual({ count: 0, results: [] });
  });

  it('wendet das denied-Mandantenset auf jede client-gebundene Quelle an', async () => {
    m.readModules.mockResolvedValue({ invoiceMode: 'EXTERNAL', knowledge: false });

    await GET(request());

    expect(m.client).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { notIn: ['client-denied'] } }),
      }),
    );
    for (const query of [m.request, m.invoice]) {
      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ clientId: { notIn: ['client-denied'] } }),
        }),
      );
    }
    expect(m.document).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ clientId: null }, { clientId: { notIn: ['client-denied'] } }],
        }),
      }),
    );
  });
});
