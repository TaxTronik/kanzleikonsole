import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  env: {
    SMTP_HOST: 'smtp.example.test',
    SMTP_FROM: 'Kanzlei <kanzlei@example.test>',
  },
}));

vi.mock('@taxtronik/config', () => ({ env: mocks.env }));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: async (
    _ctx: unknown,
    fn: (tx: { tenantSetting: { findUnique: typeof mocks.findUnique } }) => unknown,
  ) => fn({ tenantSetting: { findUnique: mocks.findUnique } }),
}));
vi.mock('@taxtronik/crypto', () => ({
  encryptSecret: vi.fn(),
  readEncryptedSetting: vi.fn(),
}));
vi.mock('../logger', () => ({ mailLog: () => ({ warn: vi.fn() }) }));

import { getSmtpStatus } from '../smtp-settings';

const ctx = { tenantId: 'tenant-1', actorId: null, actorType: 'SYSTEM' as const };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.env.SMTP_HOST = 'smtp.example.test';
  mocks.env.SMTP_FROM = 'Kanzlei <kanzlei@example.test>';
});

describe('getSmtpStatus', () => {
  it('erkennt den aktiven ENV-Fallback ohne Tenant-Setting', async () => {
    mocks.findUnique.mockResolvedValue(null);
    await expect(getSmtpStatus(ctx)).resolves.toEqual({ configured: true, fromDb: false });
  });

  it('meldet eine vollständige Tenant-Konfiguration als wirksame Quelle', async () => {
    mocks.findUnique.mockResolvedValue({
      value: { host: 'tenant.smtp.test', from: 'Mandant <mail@example.test>' },
    });
    await expect(getSmtpStatus(ctx)).resolves.toEqual({ configured: true, fromDb: true });
  });

  it('fällt bei einem unvollständigen Tenant-Setting wie der Versand auf ENV zurück', async () => {
    mocks.findUnique.mockResolvedValue({ value: { host: '', from: '' } });
    await expect(getSmtpStatus(ctx)).resolves.toEqual({ configured: true, fromDb: false });
  });
});
