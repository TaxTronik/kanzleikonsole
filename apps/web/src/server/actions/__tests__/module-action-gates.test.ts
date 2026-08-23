import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BOOLEAN_MODULE_KEYS, type BooleanTenantModuleKey } from '@taxtronik/db/tenant-modules';

const h = vi.hoisted(() => {
  class MockModuleDisabledError extends Error {
    constructor(public readonly module: BooleanTenantModuleKey) {
      super(`Modul ${module} ist deaktiviert.`);
      this.name = 'ModuleDisabledError';
    }
  }
  return {
    MockModuleDisabledError,
    staffAuth: vi.fn(),
    portalAuth: vi.fn(),
    assertModuleEnabled: vi.fn(),
    readModules: vi.fn(),
    withTenantContext: vi.fn(),
  };
});

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@taxtronik/db/tenant-context', () => ({
  withTenantContext: h.withTenantContext,
}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: h.staffAuth }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: h.portalAuth }));
vi.mock('@/server/auth/rbac', () => ({
  isStaffAdmin: () => false,
  hasStaffPermission: () => true,
  toActionError: () => ({ ok: false, error: 'Fehler.' }),
  ActionError: class ActionError extends Error {},
}));
vi.mock('@/server/settings/modules', () => ({
  assertModuleEnabled: h.assertModuleEnabled,
  readModules: h.readModules,
  isModeModuleEnabled: (cfg: { poaMode: string; invoiceMode: string }, module: string) =>
    module === 'poa' ? cfg.poaMode !== 'OFF' : cfg.invoiceMode !== 'OFF',
  ModuleDisabledError: h.MockModuleDisabledError,
}));

import { staffActionGuard, withStaffModule } from '../staff-action';
import { portalActionGuard, withPortalModule } from '../portal-action';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  h.assertModuleEnabled.mockReset().mockResolvedValue(undefined);
  h.readModules.mockReset().mockResolvedValue({ poaMode: 'MARKDOWN_OTP', invoiceMode: 'IN_APP' });
  h.withTenantContext
    .mockReset()
    .mockImplementation(async (_ctx, callback: (tx: object) => Promise<unknown>) => callback({}));
  h.staffAuth.mockResolvedValue({
    user: {
      tenantId: TENANT_ID,
      staffId: '22222222-2222-4222-8222-222222222222',
    },
  });
  h.portalAuth.mockResolvedValue({
    user: {
      tenantId: TENANT_ID,
      contactId: '33333333-3333-4333-8333-333333333333',
      clientId: '44444444-4444-4444-8444-444444444444',
    },
  });
});

describe('tenantweite Modul-Gates für direkte Server-Actions', () => {
  it.each(BOOLEAN_MODULE_KEYS)('blockiert %s zentral vor der Staff-Mutation', async (module) => {
    h.assertModuleEnabled.mockRejectedValueOnce(new h.MockModuleDisabledError(module));
    const mutation = vi.fn();

    await expect(staffActionGuard({ module })).resolves.toEqual({
      ok: false,
      error: `Modul ${module} ist deaktiviert.`,
    });
    await expect(withStaffModule(module)(mutation)).resolves.toEqual({
      ok: true,
    });

    // Der zweite Aufruf verwendet den Default-Mock (aktiv) und beweist, dass
    // der gebundene Wrapper das Modul an das zentrale Gate weiterreicht.
    expect(h.assertModuleEnabled).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ tenantId: TENANT_ID }),
      module,
    );
    expect(h.assertModuleEnabled).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ tenantId: TENANT_ID }),
      module,
    );
  });

  it.each(BOOLEAN_MODULE_KEYS)('blockiert %s zentral vor der Portal-Mutation', async (module) => {
    h.assertModuleEnabled.mockRejectedValueOnce(new h.MockModuleDisabledError(module));

    await expect(portalActionGuard({ module })).resolves.toEqual({
      ok: false,
      error: `Modul ${module} ist deaktiviert.`,
    });
  });

  it('führt gebundene Staff-/Portal-Callbacks bei deaktiviertem Modul nicht aus', async () => {
    const staffMutation = vi.fn();
    const portalMutation = vi.fn();
    h.assertModuleEnabled.mockRejectedValue(new h.MockModuleDisabledError('forms'));

    await expect(withStaffModule('forms')(staffMutation)).resolves.toMatchObject({ ok: false });
    await expect(withPortalModule('forms')(portalMutation)).resolves.toMatchObject({ ok: false });

    expect(staffMutation).not.toHaveBeenCalled();
    expect(portalMutation).not.toHaveBeenCalled();
    expect(h.withTenantContext).not.toHaveBeenCalled();
  });

  it.each([
    ['invoices', { poaMode: 'MARKDOWN_OTP', invoiceMode: 'OFF' }, 'Rechnungen'],
    ['poa', { poaMode: 'OFF', invoiceMode: 'IN_APP' }, 'Vollmachten'],
  ] as const)(
    'blockiert das OFF-Modul %s vor der Staff-Mutation',
    async (modeModule, cfg, label) => {
      h.readModules.mockResolvedValueOnce(cfg);
      const mutation = vi.fn();

      await expect(staffActionGuard({ modeModule })).resolves.toEqual({
        ok: false,
        error: `Das Modul ${label} ist deaktiviert.`,
      });

      expect(mutation).not.toHaveBeenCalled();
      expect(h.withTenantContext).not.toHaveBeenCalled();
    },
  );
});
