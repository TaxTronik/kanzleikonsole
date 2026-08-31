import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), findMany: vi.fn(), record: vi.fn() }));
vi.mock('@/server/auth/staff', () => ({ staffAuth: mocks.auth }));
vi.mock('@/server/auth/rbac', () => ({
  isStaffAdmin: (session: { user: { roles: string[] } }) =>
    session.user.roles.some((role) => ['ADMIN', 'PARTNER'].includes(role)),
}));
vi.mock('@/server/rate-limit', () => ({
  checkStaffExportLimit: async () => ({ ok: true }),
  getClientIp: () => null,
}));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({ auditLog: { findMany: mocks.findMany } }),
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: mocks.record } }));
import { GET } from '../route';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({
    user: { tenantId: 'tenant', staffId: 'staff', roles: ['ADMIN'] },
  });
  mocks.findMany.mockResolvedValue([]);
});

describe('AUDIT-HASH-CHAIN-001 / ACCESS-STAFF-PERMISSION-001: audit export selection', () => {
  it('does not grant audit access through professional qualification', async () => {
    mocks.auth.mockResolvedValueOnce({ user: { roles: ['EMPLOYEE'], isProfessional: true } });
    expect(
      (await GET(new NextRequest('http://localhost/api/staff/admin/audit/export'))).status,
    ).toBe(403);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
  it('uses category, order and Berlin day bounds while ignoring page cursors', async () => {
    const response = await GET(
      new NextRequest(
        'http://localhost/api/staff/admin/audit/export?category=gwg&sort=oldest&from=2026-03-29&to=2026-03-29&cursor=100',
      ),
    );
    expect(response.status).toBe(200);
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: {
        AND: [
          {
            action: {
              in: expect.arrayContaining(['gwg.check.verify', 'client.update.gwg_relevant']),
            },
          },
        ],
        occurredAt: { gte: new Date('2026-03-28T23:00:00Z'), lt: new Date('2026-03-29T22:00:00Z') },
      },
      orderBy: { id: 'asc' },
      take: 10001,
    });
    expect(mocks.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        after: {
          rows: 0,
          truncated: false,
          filters: { category: 'gwg', sort: 'oldest', from: '2026-03-29', to: '2026-03-29' },
        },
      }),
    );
  });
  it('rejects invalid filters without reading or exporting the full log', async () => {
    expect(
      (await GET(new NextRequest('http://localhost/api/staff/admin/audit/export?category=invalid')))
        .status,
    ).toBe(400);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
});
