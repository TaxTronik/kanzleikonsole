// Fachkatalog: PORTAL-INBOX-SUBMISSION-001

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '@taxtronik/db';

const mocks = vi.hoisted(() => ({
  withTenantContext: vi.fn(),
  readTenantSettingValue: vi.fn(),
  writeTenantSettingValue: vi.fn(),
}));

vi.mock('@taxtronik/db', () => ({
  withTenantContext: mocks.withTenantContext,
}));
vi.mock('@taxtronik/db/tenant-settings', () => ({
  readTenantSettingValue: mocks.readTenantSettingValue,
  writeTenantSettingValue: mocks.writeTenantSettingValue,
}));

import { DEFAULT_PORTAL_FEATURES, readPortalFeatures } from '../portal-features';

const CTX: TenantContext = {
  tenantId: 'tenant-a',
  actorId: 'staff-a',
  actorType: 'STAFF',
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.withTenantContext.mockImplementation(
    async (_ctx: TenantContext, fn: (tx: object) => unknown) => fn({}),
  );
});

describe('PortalFeatures.clientInbox', () => {
  it('ist für neue und bestehende Tenants ohne gespeicherten Schlüssel opt-in false', async () => {
    mocks.readTenantSettingValue.mockResolvedValueOnce(undefined).mockResolvedValueOnce({});

    expect(await readPortalFeatures(CTX)).toEqual(DEFAULT_PORTAL_FEATURES);
    expect((await readPortalFeatures(CTX)).clientInbox).toBe(false);
  });

  it('wird ausschließlich durch den expliziten booleschen Wert true aktiviert', async () => {
    mocks.readTenantSettingValue
      .mockResolvedValueOnce({ clientInbox: true })
      .mockResolvedValueOnce({ clientInbox: 'true' });

    expect((await readPortalFeatures(CTX)).clientInbox).toBe(true);
    expect((await readPortalFeatures(CTX)).clientInbox).toBe(false);
  });
});
