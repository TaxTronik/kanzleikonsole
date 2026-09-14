// Fachkatalog: ACCESS-STAFF-PERMISSION-001, ACCESS-TENANT-RLS-001,
// PORTAL-INBOX-SUBMISSION-001
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BOOLEAN_TENANT_MODULES } from '@taxtronik/db/tenant-modules';

const m = vi.hoisted(() => ({
  requireStaffPage: vi.fn(),
  withTenantContext: vi.fn(),
  inaccessibleClientIdsFor: vi.fn(),
  hasStaffPermission: vi.fn(),
  readModules: vi.fn(),
  readPortalFeatures: vi.fn(),
  renderWidget: vi.fn(),
}));
vi.mock('@/server/auth/staff-page', () => ({ requireStaffPage: m.requireStaffPage }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));
vi.mock('@/server/auth/rbac', () => ({
  isStaffAdmin: () => false,
  inaccessibleClientIdsFor: m.inaccessibleClientIdsFor,
  hasStaffPermission: m.hasStaffPermission,
}));
vi.mock('@/server/settings/modules', () => ({ readModules: m.readModules }));
vi.mock('@/server/settings/portal-features', () => ({ readPortalFeatures: m.readPortalFeatures }));
vi.mock('@/server/setup/status', () => ({ getSetupStatus: vi.fn() }));
vi.mock('../widgets', () => ({ renderWidget: m.renderWidget }));
vi.mock('../dashboard-grid', () => ({ DashboardGrid: () => null }));

import DashboardPage from '../page';

describe('Initialer Dashboard-Arbeitskorb', () => {
  const session = { user: { tenantId: 'tenant-a', staffId: 'staff-a', fullName: 'Person A' } };
  const tx = { staffUser: { findUnique: vi.fn() } };
  const modules = { ...DEFAULT_BOOLEAN_TENANT_MODULES, reminders: false };

  beforeEach(() => {
    vi.clearAllMocks();
    m.requireStaffPage.mockResolvedValue(session);
    m.withTenantContext.mockImplementation(async (_ctx, run) => run(tx));
    m.inaccessibleClientIdsFor.mockResolvedValue(['client-denied']);
    m.readModules.mockResolvedValue(modules);
    tx.staffUser.findUnique.mockResolvedValue({
      dashboardLayout: {
        version: 2,
        widgets: [{ id: 'basket', type: 'my_work_basket', x: 0, y: 0, w: 4, h: 12 }],
      },
    });
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])('verlangt Feature %s und Einzelrecht %s vor Inbox-Daten', async (feature, permission) => {
    m.hasStaffPermission.mockReturnValue(permission);
    m.readPortalFeatures.mockResolvedValue({ clientInbox: feature });

    await DashboardPage();

    expect(m.hasStaffPermission).toHaveBeenCalledWith(session, 'PORTAL_INBOX_MANAGE');
    expect(m.renderWidget).toHaveBeenCalledWith('my_work_basket', {
      tx,
      tenantId: 'tenant-a',
      staffId: 'staff-a',
      isAdmin: false,
      deniedClientIds: ['client-denied'],
      modules,
      portalInboxEnabled: feature && permission,
    });
    if (permission) {
      expect(m.readPortalFeatures).toHaveBeenCalledWith({
        tenantId: 'tenant-a',
        actorId: 'staff-a',
        actorType: 'STAFF',
      });
    } else expect(m.readPortalFeatures).not.toHaveBeenCalled();
  });
});
