import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  withStaff: vi.fn(),
  inaccessibleClientIdsFor: vi.fn(),
  isStaffAdmin: vi.fn(),
  renderWidget: vi.fn(),
  readBooleanTenantModules: vi.fn(),
  hasStaffPermission: vi.fn(),
  readPortalFeaturesTx: vi.fn(),
}));

vi.mock('@/server/actions/staff-action', () => ({
  ActionError: class ActionError extends Error {},
  withStaff: m.withStaff,
}));
vi.mock('@taxtronik/db/tenant-modules', () => ({
  readBooleanTenantModules: m.readBooleanTenantModules,
}));
vi.mock('@/server/auth/rbac', () => ({
  inaccessibleClientIdsFor: m.inaccessibleClientIdsFor,
  isStaffAdmin: m.isStaffAdmin,
  hasStaffPermission: m.hasStaffPermission,
}));
vi.mock('@/server/settings/portal-features', () => ({
  readPortalFeaturesTx: m.readPortalFeaturesTx,
}));
vi.mock('../widgets', () => ({ renderWidget: m.renderWidget }));

import { addDashboardWidgetAction, saveDashboardLayoutAction } from '../actions';

const widget = {
  id: 'w-test',
  type: 'kpi_clients' as const,
  x: 0,
  y: 0,
  w: 3,
  h: 3,
};

describe('Dashboard-Layout-Actions', () => {
  const tx = { staffUser: { update: vi.fn() } };

  beforeEach(() => {
    vi.clearAllMocks();
    m.inaccessibleClientIdsFor.mockResolvedValue(['restricted-client']);
    m.isStaffAdmin.mockReturnValue(true);
    m.hasStaffPermission.mockReturnValue(false);
    m.readPortalFeaturesTx.mockResolvedValue({ clientInbox: false });
    m.renderWidget.mockResolvedValue('nur-neues-widget');
    m.readBooleanTenantModules.mockResolvedValue({
      bwa: true,
      knowledge: true,
      timeTracking: true,
      phoneNotes: true,
      taxNotices: true,
      workflows: true,
      forms: true,
      reminders: true,
      binders: true,
      handovers: true,
      appointments: true,
      rssReader: true,
      inboundMail: true,
      risk: true,
      signalEngine: true,
    });
    m.withStaff.mockImplementation(
      async (fn: (tx: unknown, context: unknown) => Promise<unknown>) => ({
        ok: true,
        ...((await fn(tx, {
          tenantId: 'tenant-1',
          staffId: 'staff-1',
          session: {},
        })) as Record<string, unknown>),
      }),
    );
  });

  it('speichert und rendert beim Hinzufügen nur den neuen Widget-Slot', async () => {
    const result = await addDashboardWidgetAction({ version: 2, widgets: [widget] }, widget.id);

    expect(result).toEqual({
      ok: true,
      rendered: { widget, node: 'nur-neues-widget' },
    });
    expect(tx.staffUser.update).toHaveBeenCalledTimes(1);
    expect(m.renderWidget).toHaveBeenCalledTimes(1);
    expect(m.renderWidget).toHaveBeenCalledWith(
      'kpi_clients',
      expect.objectContaining({
        tx,
        staffId: 'staff-1',
        isAdmin: true,
        deniedClientIds: ['restricted-client'],
      }),
    );
  });

  it('speichert normale Layout-Änderungen ohne zusätzlichen Revalidate-Parameter', async () => {
    await saveDashboardLayoutAction({ version: 2, widgets: [widget] });

    expect(m.withStaff).toHaveBeenLastCalledWith(expect.any(Function));
  });

  // Fachkatalog: ACCESS-STAFF-PERMISSION-001, PORTAL-INBOX-SUBMISSION-001
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])('bindet den Arbeitskorb an Feature %s und Einzelrecht %s', async (feature, permission) => {
    m.hasStaffPermission.mockReturnValue(permission);
    m.readPortalFeaturesTx.mockResolvedValue({ clientInbox: feature });
    const basket = { ...widget, type: 'my_work_basket' as const };

    await addDashboardWidgetAction({ version: 2, widgets: [basket] }, basket.id);

    expect(m.hasStaffPermission).toHaveBeenCalledWith({}, 'PORTAL_INBOX_MANAGE');
    expect(m.renderWidget).toHaveBeenCalledWith(
      'my_work_basket',
      expect.objectContaining({
        tx,
        tenantId: 'tenant-1',
        staffId: 'staff-1',
        modules: expect.objectContaining({ reminders: true, workflows: true }),
        deniedClientIds: ['restricted-client'],
        portalInboxEnabled: feature && permission,
      }),
    );
    if (permission) expect(m.readPortalFeaturesTx).toHaveBeenCalledWith(tx, 'tenant-1');
    else expect(m.readPortalFeaturesTx).not.toHaveBeenCalled();
  });
});
