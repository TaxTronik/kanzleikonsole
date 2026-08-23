import { describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  staffAuth: vi.fn(),
  readModules: vi.fn(),
  checkStaffExportLimit: vi.fn(),
  withTenantContext: vi.fn(),
}));

vi.mock('@/server/auth/staff', () => ({ staffAuth: m.staffAuth }));
vi.mock('@/server/settings/modules', () => ({
  readModules: m.readModules,
  isModeModuleEnabled: (cfg: { invoiceMode: string }) => cfg.invoiceMode !== 'OFF',
}));
vi.mock('@/server/rate-limit', () => ({
  checkStaffExportLimit: m.checkStaffExportLimit,
  getClientIp: vi.fn(),
}));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));
vi.mock('@/server/auth/rbac', () => ({ inaccessibleClientIdsFor: vi.fn() }));
vi.mock('@/server/container', () => ({ evidenceService: { record: vi.fn() } }));

import { GET } from '../route';

describe('Invoice-CSV-Modulgate', () => {
  it('antwortet bei invoiceMode=OFF als nicht adressierbar vor Rate-Limit und DB', async () => {
    m.staffAuth.mockResolvedValue({
      user: { tenantId: 'tenant-1', staffId: 'staff-1' },
    });
    m.readModules.mockResolvedValue({ invoiceMode: 'OFF' });

    const response = await GET({} as never);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'not_found' });
    expect(m.checkStaffExportLimit).not.toHaveBeenCalled();
    expect(m.withTenantContext).not.toHaveBeenCalled();
  });
});
