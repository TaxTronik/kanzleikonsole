// Fachkatalog: ACCESS-CLIENT-MODE-001, ACCESS-SEARCH-SCOPE-001
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  staffAuth: vi.fn(),
  rateLimit: vi.fn(),
  withTenantContext: vi.fn(),
  search: vi.fn(),
}));

vi.mock('@/server/auth/staff', () => ({ staffAuth: m.staffAuth }));
vi.mock('@/server/rate-limit', () => ({ checkStaffClientPickerLimit: m.rateLimit }));
vi.mock('@/server/clients/picker', () => ({ searchClientPickerTx: m.search }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));

import { GET } from '../route';

const request = (params: Record<string, string> = {}) =>
  ({ nextUrl: { searchParams: new URLSearchParams(params) } }) as never;

const session = { user: { tenantId: 'tenant-1', staffId: 'staff-1', roles: ['EMPLOYEE'] } };
const tx = { marker: 'tx' };

describe('GET /api/staff/clients/search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.staffAuth.mockResolvedValue(session);
    m.rateLimit.mockResolvedValue({ ok: true, remaining: 10, retryAfter: 0 });
    m.withTenantContext.mockImplementation(async (_ctx, fn) => fn(tx));
    m.search.mockResolvedValue({ clients: [], limited: false, mode: 'search' });
  });

  it('verlangt eine Staff-Session und fragt ohne sie nichts ab', async () => {
    m.staffAuth.mockResolvedValue(null);
    const response = await GET(request({ q: 'muster' }));
    expect(response.status).toBe(401);
    expect(m.withTenantContext).not.toHaveBeenCalled();
    expect(m.rateLimit).not.toHaveBeenCalled();
  });

  it('weist unbekannte Filter und überlange Suchbegriffe vor der Datenbank ab', async () => {
    expect((await GET(request({ filter: 'all' }))).status).toBe(400);
    expect((await GET(request({ q: 'x'.repeat(101) }))).status).toBe(400);
    expect(m.withTenantContext).not.toHaveBeenCalled();
  });

  it('drosselt pro Mitarbeiter mit eigenem Kontingent', async () => {
    m.rateLimit.mockResolvedValue({ ok: false, remaining: 0, retryAfter: 17 });
    const response = await GET(request({ q: 'muster' }));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('17');
    expect(m.rateLimit).toHaveBeenCalledWith('staff-1');
    expect(m.search).not.toHaveBeenCalled();
  });

  it('sucht im Tenant-Kontext der Session mit kanonischen Filtern und speichert nichts', async () => {
    const result = {
      clients: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          name: 'Muster GmbH',
          datevNo: '1001',
          addisonNo: null,
          allowActive: true,
          mandateEnded: false,
        },
      ],
      limited: true,
      mode: 'search',
    };
    m.search.mockResolvedValue(result);
    const response = await GET(request({ q: ' muster ', filter: 'notEnded,active' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual(result);
    expect(m.withTenantContext).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
      expect.any(Function),
    );
    expect(m.search).toHaveBeenCalledWith(tx, session, {
      query: 'muster',
      filters: ['active', 'notEnded'],
    });
  });
});
