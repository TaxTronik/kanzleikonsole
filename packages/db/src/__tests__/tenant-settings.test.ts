import { describe, expect, it, vi } from 'vitest';

import {
  deleteTenantSettingValue,
  readTenantSettingValue,
  writeTenantSettingValue,
} from '../tenant-settings';

function settingDb() {
  return {
    tenantSetting: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
  };
}

describe('tenant_setting persistence primitive', () => {
  it('liest nur den JSON-Wert ueber den zusammengesetzten Tenant-Key', async () => {
    const db = settingDb();
    db.tenantSetting.findUnique.mockResolvedValue({ value: { enabled: true } });

    await expect(readTenantSettingValue(db as never, 'tenant-1', 'feature')).resolves.toEqual({
      enabled: true,
    });
    expect(db.tenantSetting.findUnique).toHaveBeenCalledWith({
      where: { tenantId_key: { tenantId: 'tenant-1', key: 'feature' } },
      select: { value: true },
    });
  });

  it('unterscheidet eine fehlende Zeile von gespeichertem JSON-null', async () => {
    const db = settingDb();
    db.tenantSetting.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ value: null });

    await expect(
      readTenantSettingValue(db as never, 'tenant-1', 'missing'),
    ).resolves.toBeUndefined();
    await expect(readTenantSettingValue(db as never, 'tenant-1', 'json-null')).resolves.toBeNull();
  });

  it('schreibt Create und Update mit identischem Wert und Bearbeiter', async () => {
    const db = settingDb();
    const value = { mode: 'STRICT' };

    await writeTenantSettingValue(db as never, {
      tenantId: 'tenant-1',
      key: 'policy',
      value,
      updatedBy: 'staff-1',
    });

    expect(db.tenantSetting.upsert).toHaveBeenCalledWith({
      where: { tenantId_key: { tenantId: 'tenant-1', key: 'policy' } },
      create: {
        tenantId: 'tenant-1',
        key: 'policy',
        value,
        updatedBy: 'staff-1',
      },
      update: { value, updatedBy: 'staff-1' },
    });
  });

  it('loescht idempotent anhand von Tenant und Key', async () => {
    const db = settingDb();
    await deleteTenantSettingValue(db as never, 'tenant-1', 'obsolete');
    expect(db.tenantSetting.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1', key: 'obsolete' },
    });
  });
});
