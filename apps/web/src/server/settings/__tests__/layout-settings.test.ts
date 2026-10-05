// Fachkatalog: ACCESS-TENANT-RLS-001, PORTAL-INBOX-SUBMISSION-001
// P-06: Layout-Einstellungen in EINER Transaktion, request-scoped geteilt mit den
// Settings-Reads der Seite; prozessweit gecacht nur das Branding.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '@taxtronik/db';

// React cache() wirkt nur im Server-Render. Hier simuliert ein Request-Scope,
// den newRequest() verwirft, dieselbe Semantik (gleiche Argumente → gleicher Wert).
const request = vi.hoisted(() => ({ caches: new WeakMap<object, Map<string, unknown>>() }));
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  cache:
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      let perFn = request.caches.get(fn);
      if (!perFn) {
        perFn = new Map();
        request.caches.set(fn, perFn);
      }
      const key = JSON.stringify(args);
      if (!perFn.has(key)) perFn.set(key, fn(...args));
      return perFn.get(key) as R;
    },
}));

const m = vi.hoisted(() => ({
  withTenantContext: vi.fn(),
  settings: new Map<string, unknown>(),
  findMany: vi.fn(),
  tenantFindUnique: vi.fn(),
  staffFindFirst: vi.fn(),
  contactFindFirst: vi.fn(),
  contactFindMany: vi.fn(),
  clientFindUnique: vi.fn(),
  aggregate: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@taxtronik/db/tenant-context', () => ({ withTenantContext: m.withTenantContext }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));
vi.mock('@/server/db/prisma-owner', () => ({ prismaOwner: {} }));

import { readStaffLayoutData, readPortalLayoutData } from '../layout-data';
import { invalidateBrandingCache, BRANDING_CACHE_TTL_MS } from '../layout-settings';
import { readModules, DEFAULT_MODULES } from '../modules';
import { readBranding } from '../branding';
import { readPortalFeatures } from '../portal-features';
import { readAccessibleDisplay, readAccessibleDisplayOptions } from '../accessible-display';

const STAFF = { tenantId: 'tenant-a', actorId: 'staff-a', actorType: 'STAFF' } as const;
const CONTACT = {
  tenantId: 'tenant-a',
  actorId: 'contact-a',
  actorType: 'CLIENT_CONTACT',
} as const;

const tx = {
  tenantSetting: {
    findMany: m.findMany,
    findUnique: async ({ where }: { where: { tenantId_key: { key: string } } }) =>
      m.settings.has(where.tenantId_key.key)
        ? { value: m.settings.get(where.tenantId_key.key) }
        : null,
  },
  tenant: { findUnique: m.tenantFindUnique },
  staffUser: { findFirst: m.staffFindFirst },
  clientContact: { findFirst: m.contactFindFirst, findMany: m.contactFindMany },
  client: { findUnique: m.clientFindUnique },
  notification: { aggregate: m.aggregate },
};

function newRequest() {
  request.caches = new WeakMap();
}

/** Keys der jeweils gelesenen Tenant-Settings je findMany-Aufruf. */
function readKeys(): string[][] {
  return m.findMany.mock.calls.map(([args]) => [...args.where.key.in].sort());
}

beforeEach(() => {
  vi.clearAllMocks();
  newRequest();
  invalidateBrandingCache();
  m.settings = new Map<string, unknown>([
    ['branding', { displayName: 'Kanzlei Müller', accentColor: '#112233' }],
    ['modules', { forms: false }],
    ['portal.features', { clientInbox: true }],
  ]);
  m.withTenantContext.mockImplementation(async (_ctx: TenantContext, fn: (t: object) => unknown) =>
    fn(tx),
  );
  m.findMany.mockImplementation(async ({ where }: { where: { key: { in: string[] } } }) =>
    where.key.in
      .filter((key) => m.settings.has(key))
      .map((key) => ({ key, value: m.settings.get(key) })),
  );
  m.tenantFindUnique.mockResolvedValue({ name: 'Tenant A' });
  m.staffFindFirst.mockResolvedValue({
    accessibleDisplay: true,
    accessibleDisplayFontSize: 'standard',
  });
  m.contactFindFirst.mockResolvedValue({ email: 'mandant@example.test', accessibleDisplay: false });
  m.contactFindMany.mockResolvedValue([]);
  m.clientFindUnique.mockResolvedValue({ name: 'Mandant GmbH' });
  m.aggregate.mockResolvedValue({ _count: { _all: 3 }, _max: { createdAt: null } });
});

describe('Staff-Layout (P-06)', () => {
  it('lädt Einstellungen, Darstellung und Glocke in genau einer Transaktion', async () => {
    const data = await readStaffLayoutData(STAFF);

    expect(m.withTenantContext).toHaveBeenCalledTimes(1);
    expect(readKeys()).toEqual([['branding', 'modules', 'portal.features']]);
    expect(data.branding.displayName).toBe('Kanzlei Müller');
    expect(data.modules.forms).toBe(false);
    expect(data.portalFeatures.clientInbox).toBe(true);
    expect(data.accessibleDisplay).toBe(true);
    expect(data.accessibleDisplayOptions.fontSize).toBe('standard');
    expect(data.notifications).toEqual({ unread: 3, latestUnreadAt: null });
    expect(m.aggregate).toHaveBeenCalledWith({
      where: { OR: [{ staffId: 'staff-a' }, { staffId: null }], readAt: null },
      _count: { _all: true },
      _max: { createdAt: true },
    });
  });

  it('teilt die Transaktion mit Modul- und Settings-Reads der Seite derselben Anfrage', async () => {
    const page = { ...STAFF };
    const [layout, modules, branding, features, display, options] = await Promise.all([
      readStaffLayoutData(STAFF),
      readModules(page),
      readBranding(page),
      readPortalFeatures(page),
      readAccessibleDisplay(page),
      readAccessibleDisplayOptions(page),
    ]);

    expect(m.withTenantContext).toHaveBeenCalledTimes(1);
    expect(modules).toEqual(layout.modules);
    expect(branding).toEqual(layout.branding);
    expect(features).toEqual(layout.portalFeatures);
    expect(display).toBe(true);
    expect(options).toEqual(layout.accessibleDisplayOptions);
  });

  it('liest Einstellungen nur einmal, wenn die Seite vor dem Layout lädt (Glocke separat)', async () => {
    await readModules(STAFF);
    await readStaffLayoutData(STAFF);

    expect(m.withTenantContext).toHaveBeenCalledTimes(2);
    expect(m.findMany).toHaveBeenCalledTimes(1);
    expect(m.aggregate).toHaveBeenCalledTimes(1);
  });

  it('liest Module und Portal-Features in jeder Anfrage frisch (kein Prozess-Cache)', async () => {
    await readStaffLayoutData(STAFF);
    m.settings.set('modules', { forms: true });
    m.settings.set('portal.features', { clientInbox: false });
    newRequest();

    const next = await readStaffLayoutData(STAFF);

    expect(next.modules.forms).toBe(true);
    expect(next.portalFeatures.clientInbox).toBe(false);
    expect(m.withTenantContext).toHaveBeenCalledTimes(2);
  });
});

describe('Branding-Prozess-Cache', () => {
  it('überspringt das Branding innerhalb der TTL und liest es nach Invalidierung neu', async () => {
    await readStaffLayoutData(STAFF);
    m.settings.set('branding', { displayName: 'Neu' });
    newRequest();
    const cached = await readStaffLayoutData(STAFF);

    expect(readKeys()[1]).toEqual(['modules', 'portal.features']);
    expect(cached.branding.displayName).toBe('Kanzlei Müller');

    invalidateBrandingCache('tenant-a');
    newRequest();
    const fresh = await readStaffLayoutData(STAFF);

    expect(readKeys()[2]).toEqual(['branding', 'modules', 'portal.features']);
    expect(fresh.branding.displayName).toBe('Neu');
  });

  it('läuft nach der TTL ab', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      await readStaffLayoutData(STAFF);
      now.mockReturnValue(1_000_000 + BRANDING_CACHE_TTL_MS + 1);
      newRequest();
      await readStaffLayoutData(STAFF);
    } finally {
      now.mockRestore();
    }
    expect(readKeys()).toEqual([
      ['branding', 'modules', 'portal.features'],
      ['branding', 'modules', 'portal.features'],
    ]);
  });

  it('ist je Tenant getrennt und nutzt ohne gespeichertes Branding den Tenant-Namen', async () => {
    m.settings.delete('branding');
    const a = await readBranding(STAFF);
    newRequest();
    m.tenantFindUnique.mockResolvedValue({ name: 'Tenant B' });
    const b = await readBranding({ ...STAFF, tenantId: 'tenant-b' });

    expect(a.displayName).toBe('Tenant A');
    expect(b.displayName).toBe('Tenant B');
  });
});

describe('Portal-Layout (P-06)', () => {
  it('lädt Mandant, Profile, Einstellungen und Darstellung in genau einer Transaktion', async () => {
    m.contactFindMany.mockResolvedValue([
      {
        id: 'contact-a',
        clientId: 'client-a',
        fullName: 'Erika Muster',
        email: 'mandant@example.test',
        client: { name: 'Mandant GmbH' },
      },
    ]);

    const data = await readPortalLayoutData(CONTACT, {
      clientId: 'client-a',
      email: 'mandant@example.test',
    });
    const pageModules = await readModules({ ...CONTACT });

    expect(m.withTenantContext).toHaveBeenCalledTimes(1);
    expect(m.withTenantContext).toHaveBeenCalledWith(CONTACT, expect.any(Function));
    expect(data.clientName).toBe('Mandant GmbH');
    expect(data.profiles.map((p) => p.contactId)).toEqual(['contact-a']);
    expect(data.accessibleDisplay).toBe(false);
    expect(pageModules).toEqual(data.modules);
    expect(m.clientFindUnique).toHaveBeenCalledWith({
      where: { id: 'client-a' },
      select: { name: true },
    });
  });
});

describe('neue Anfrage', () => {
  it('liest Module frisch und setzt für fehlende Schlüssel die Defaults', async () => {
    m.settings.delete('modules');
    const first = await readModules(STAFF);
    newRequest();
    const second = await readModules(STAFF);

    expect(first).toEqual(DEFAULT_MODULES);
    expect(second).toEqual(DEFAULT_MODULES);
    expect(m.withTenantContext).toHaveBeenCalledTimes(2);
  });
});
