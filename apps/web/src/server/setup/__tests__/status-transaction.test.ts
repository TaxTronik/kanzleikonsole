// P-06: Die Setup-Checkliste (Admin-Übersicht, Dashboard für Admins) liest ihren
// IST-Zustand in EINER Transaktion statt in sieben parallelen.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '@taxtronik/db';

const m = vi.hoisted(() => ({
  withTenantContext: vi.fn(),
  settings: new Map<string, unknown>(),
  contactCount: vi.fn(),
  clientCount: vi.fn(),
}));

vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));
vi.mock('@taxtronik/db/tenant-context', () => ({ withTenantContext: m.withTenantContext }));
vi.mock('@/server/db/prisma-owner', () => ({ prismaOwner: {} }));

import { getSetupStatus } from '../status';
import { SETUP_DISMISSED_SETTING_KEY } from '../constants';
import { invalidateBrandingCache } from '@/server/settings/layout-settings';

const CTX: TenantContext = { tenantId: 'tenant-a', actorId: 'staff-a', actorType: 'STAFF' };

const tx = {
  tenantSetting: {
    findUnique: async ({
      where,
      select,
    }: {
      where: { tenantId_key: { key: string } };
      select: { value?: true; tenantId?: true };
    }) => {
      const key = where.tenantId_key.key;
      if (!m.settings.has(key)) return null;
      return select.tenantId ? { tenantId: 'tenant-a' } : { value: m.settings.get(key) };
    },
  },
  tenant: { findUnique: async () => ({ name: 'Kanzlei Müller' }) },
  clientContact: { count: m.contactCount },
  client: { count: m.clientCount },
};

beforeEach(() => {
  vi.clearAllMocks();
  invalidateBrandingCache();
  m.withTenantContext.mockImplementation(async (_ctx: TenantContext, fn: (t: object) => unknown) =>
    fn(tx),
  );
  m.contactCount.mockResolvedValue(2);
  m.clientCount.mockResolvedValue(1);
  m.settings = new Map<string, unknown>([
    ['branding', { displayName: 'Kanzlei Müller', logoDataUrl: 'data:image/png;base64,AA==' }],
    ['tax_region', { region: 'HE' }],
    [
      'invoicing.seller',
      {
        street: 'Musterstraße 1',
        postalCode: '36304',
        city: 'Alsfeld',
        email: 'kanzlei@example.test',
        phone: '+49 6631 1',
        vatId: 'DE123456789',
      },
    ],
    ['mail.smtp', { host: 'smtp.example.test', from: 'kanzlei@example.test' }],
    [
      'privacy.notice',
      {
        responsibleBody: 'Kanzlei Müller',
        supervisoryAuthority: 'HBDI',
        privacyContact: 'datenschutz@example.test',
      },
    ],
    ['legal', { privacyUrl: 'https://example.test/datenschutz' }],
    ['modules', { forms: true }],
  ]);
});

describe('getSetupStatus', () => {
  it('öffnet genau eine Transaktion und wertet alle Punkte darin aus', async () => {
    const status = await getSetupStatus(CTX);

    expect(m.withTenantContext).toHaveBeenCalledTimes(1);
    expect(m.withTenantContext).toHaveBeenCalledWith(CTX, expect.any(Function));
    expect(status.allDone).toBe(true);
    expect(status.doneCount).toBe(status.totalCount);
    expect(status.dismissed).toBe(false);
  });

  it('meldet fehlende Punkte wie zuvor (Branding ohne Logo, ohne Modul-Entscheidung)', async () => {
    m.settings.set('branding', { displayName: 'Kanzlei Müller' });
    m.settings.delete('modules');
    m.settings.set(SETUP_DISMISSED_SETTING_KEY, { dismissed: true });

    const status = await getSetupStatus(CTX);

    expect(status.items.filter((item) => !item.done).map((item) => item.key)).toEqual([
      'branding',
      'modules',
    ]);
    expect(status.dismissed).toBe(true);
    expect(m.withTenantContext).toHaveBeenCalledTimes(1);
  });
});
