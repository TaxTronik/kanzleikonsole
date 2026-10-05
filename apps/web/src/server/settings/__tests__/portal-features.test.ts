// Fachkatalog: PORTAL-INBOX-SUBMISSION-001

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '@taxtronik/db';

const mocks = vi.hoisted(() => ({
  withTenantContext: vi.fn(),
  readTenantSettingValue: vi.fn(),
  readTenantSettingValues: vi.fn(),
  writeTenantSettingValue: vi.fn(),
}));

vi.mock('@taxtronik/db', () => ({
  withTenantContext: mocks.withTenantContext,
}));
// Der Request-Pfad liest über die gemeinsamen Layout-Einstellungen (P-06).
vi.mock('@taxtronik/db/tenant-context', () => ({
  withTenantContext: mocks.withTenantContext,
}));
vi.mock('@taxtronik/db/tenant-settings', () => ({
  readTenantSettingValue: mocks.readTenantSettingValue,
  readTenantSettingValues: mocks.readTenantSettingValues,
  writeTenantSettingValue: mocks.writeTenantSettingValue,
}));

import {
  DEFAULT_PORTAL_FEATURES,
  readPortalFeatures,
  readPortalFeaturesTx,
} from '../portal-features';

const CTX: TenantContext = {
  tenantId: 'tenant-a',
  actorId: 'staff-a',
  actorType: 'STAFF',
};

const layoutTx = {
  tenant: { findUnique: async () => ({ name: 'Kanzlei' }) },
  staffUser: { findFirst: async () => null },
  clientContact: { findFirst: async () => null },
};

/** Gespeicherter Wert von `portal.features` für den nächsten Layout-Read. */
function storedPortalFeatures(value: unknown) {
  mocks.readTenantSettingValues.mockResolvedValueOnce(
    new Map(value === undefined ? [] : [['portal.features', value]]),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.withTenantContext.mockImplementation(
    async (_ctx: TenantContext, fn: (tx: object) => unknown) => fn(layoutTx),
  );
});

describe('PortalFeatures.clientInbox', () => {
  it('verwendet eine vorhandene Transaktion mit denselben Opt-in-Regeln ohne neue Connection', async () => {
    const tx = {} as Parameters<typeof readPortalFeaturesTx>[0];
    mocks.readTenantSettingValue
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ clientInbox: true })
      .mockResolvedValueOnce({ clientInbox: 'true' });

    expect(await readPortalFeaturesTx(tx, 'tenant-a')).toEqual(DEFAULT_PORTAL_FEATURES);
    expect((await readPortalFeaturesTx(tx, 'tenant-a')).clientInbox).toBe(true);
    expect((await readPortalFeaturesTx(tx, 'tenant-a')).clientInbox).toBe(false);
    expect(mocks.readTenantSettingValue).toHaveBeenCalledWith(tx, 'tenant-a', 'portal.features');
    expect(mocks.withTenantContext).not.toHaveBeenCalled();
  });

  it('ist für neue und bestehende Tenants ohne gespeicherten Schlüssel opt-in false', async () => {
    storedPortalFeatures(undefined);
    storedPortalFeatures({});

    expect(await readPortalFeatures(CTX)).toEqual(DEFAULT_PORTAL_FEATURES);
    expect((await readPortalFeatures(CTX)).clientInbox).toBe(false);
  });

  it('wird ausschließlich durch den expliziten booleschen Wert true aktiviert', async () => {
    storedPortalFeatures({ clientInbox: true });
    storedPortalFeatures({ clientInbox: 'true' });

    expect((await readPortalFeatures(CTX)).clientInbox).toBe(true);
    expect((await readPortalFeatures(CTX)).clientInbox).toBe(false);
  });
});
