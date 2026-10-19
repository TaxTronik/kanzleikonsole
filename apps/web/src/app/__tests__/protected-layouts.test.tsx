// @vitest-environment jsdom
// Geschützte Staff-/Portal-Layouts und der Login-Rahmen als Render-Tests
// (B-08, Welle 15) statt Quelltextprüfung: Skip-Link und Landmarks (globale
// Accessibility-Grundlagen), profilgebundener Anzeigemodus aus der einen
// Layout-Transaktion (P-06) sowie Profil- und Abmeldewege. Mobile Navigation,
// Suche und Konto-Menü prüfen ihre eigenen Verhaltenstests; hier sind sie
// Doubles, die nur ihre Props festhalten.
import { screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderServer } from '@/__tests__/render-helpers';

const mocks = vi.hoisted(() => ({
  staffAuth: vi.fn(),
  portalAuth: vi.fn(),
  hasCookie: vi.fn(() => false),
  readStaffLayoutData: vi.fn(),
  readPortalLayoutData: vi.fn(),
  readBrandingForSlug: vi.fn(),
  readLegalForSlug: vi.fn(),
  userMenu: vi.fn(),
  tcmsKonfiguriert: vi.fn(() => false),
  pathname: '/staff/dashboard',
}));

vi.mock('@/server/auth/staff', () => ({ staffAuth: mocks.staffAuth }));
vi.mock('@/server/auth/staff-session', () => ({
  staffSessionFactory: { hasCookie: mocks.hasCookie },
}));
vi.mock('@/server/auth/portal', () => ({ portalAuth: mocks.portalAuth }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => ({ get: () => mocks.pathname }),
}));
vi.mock('next/navigation', () => ({
  redirect: (href: string) => {
    throw new Error(`redirect:${href}`);
  },
  notFound: () => {
    throw new Error('notFound');
  },
  usePathname: () => mocks.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/server/settings/layout-data', () => ({
  readStaffLayoutData: mocks.readStaffLayoutData,
  readPortalLayoutData: mocks.readPortalLayoutData,
}));
vi.mock('@/server/settings/branding', () => ({ readBrandingForSlug: mocks.readBrandingForSlug }));
vi.mock('@/server/settings/legal', () => ({ readLegalForSlug: mocks.readLegalForSlug }));
vi.mock('@/server/actions/accessible-display', () => ({
  saveStaffAccessibleDisplayAction: vi.fn(async () => ({ ok: true })),
  saveStaffAccessibleDisplayOptionsAction: vi.fn(async () => ({ ok: true })),
  savePortalAccessibleDisplayAction: vi.fn(async () => ({ ok: true })),
  savePortalAccessibleDisplayOptionsAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/components/global-search', () => ({ GlobalSearch: () => null }));
vi.mock('@/components/notifications-bell', () => ({ NotificationsBell: () => null }));
vi.mock('@/components/auto-refresh', () => ({ AutoRefresh: () => null }));
vi.mock('@/components/theme-toggle', () => ({ ThemeToggle: () => null }));
vi.mock('@/components/ui-mode-toggle', () => ({ UiModeToggle: () => null }));
vi.mock('@/components/mobile-sidebar-toggle', () => ({ MobileSidebarToggle: () => null }));
vi.mock('@/components/user-menu', () => ({
  UserMenu: (props: Record<string, unknown>) => {
    mocks.userMenu(props);
    return null;
  },
}));
vi.mock('../portal/(protected)/profile-switcher', () => ({ PortalProfileSwitcher: () => null }));
vi.mock('@/server/tcms/dienst', () => ({ tcmsKonfiguriert: mocks.tcmsKonfiguriert }));

import { DEFAULT_MODULES } from '@/server/settings/modules';
import { DEFAULT_PORTAL_FEATURES } from '@/server/settings/portal-features';
import { DEFAULT_DISPLAY_OPTIONS } from '@/lib/accessible-display-options';
import StaffLayout from '../staff/(protected)/layout';
import PortalLayout from '../portal/(protected)/layout';
import StaffAuthLayout from '../staff/(auth)/layout';
import PortalAuthLayout from '../portal/(auth)/layout';

const TENANT = '11111111-1111-4111-8111-111111111111';
const STAFF = '22222222-2222-4222-8222-222222222222';
const CONTACT = '33333333-3333-4333-8333-333333333333';
const CLIENT = '44444444-4444-4444-8444-444444444444';
const BRANDING = {
  displayName: 'Kanzlei Muster',
  accentColor: '#2563eb',
  subtitle: null,
  logoDataUrl: null,
  logoDataUrlDark: null,
};

function layoutData(accessibleDisplay: boolean) {
  return {
    branding: BRANDING,
    modules: DEFAULT_MODULES,
    portalFeatures: DEFAULT_PORTAL_FEATURES,
    accessibleDisplay,
    accessibleDisplayOptions: DEFAULT_DISPLAY_OPTIONS,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pathname = '/staff/dashboard';
  mocks.staffAuth.mockResolvedValue({
    user: {
      tenantId: TENANT,
      staffId: STAFF,
      roles: ['ADMIN'],
      permissions: [],
      fullName: 'Erika Muster',
      email: 'erika@kanzlei.example',
    },
  });
  mocks.portalAuth.mockResolvedValue({
    user: {
      tenantId: TENANT,
      contactId: CONTACT,
      clientId: CLIENT,
      fullName: 'Max Mandant',
      email: 'max@mandant.example',
    },
  });
  mocks.readStaffLayoutData.mockResolvedValue({
    ...layoutData(false),
    notifications: { unread: 0, latestUnreadAt: null },
  });
  mocks.readPortalLayoutData.mockResolvedValue({
    ...layoutData(false),
    clientName: 'Muster GmbH',
    profiles: [],
  });
  mocks.readBrandingForSlug.mockResolvedValue(BRANDING);
  mocks.readLegalForSlug.mockResolvedValue({ imprintUrl: null, privacyUrl: null });
});

const page = <p>Seiteninhalt</p>;

function expectLandmarks() {
  const skip = screen.getByRole('link', { name: 'Zum Hauptinhalt springen' });
  expect(skip.getAttribute('href')).toBe('#main-content');
  expect(skip.classList.contains('skip-link')).toBe(true);
  const sidebar = screen.getByRole('complementary', { name: 'Hauptmenü' });
  expect(sidebar.id).toBe('app-sidebar');
  const main = screen.getByRole('main');
  expect(main.id).toBe('main-content');
  expect(main.getAttribute('tabindex')).toBe('-1');
  expect(within(main).getByText('Seiteninhalt')).toBeTruthy();
  return { sidebar, main };
}

function displayMarker(): string | null {
  return (
    document.querySelector('[data-accessible-display]')?.getAttribute('data-accessible-display') ??
    null
  );
}

describe('geschütztes Staff-Layout', () => {
  it('stellt Skip-Link, Sidebar-Ziel und fokussierbares Main bereit', async () => {
    await renderServer(StaffLayout({ children: page }));
    expectLandmarks();
  });

  it('verlinkt das Profil im Konto-Menü und behält das Abmelden in der Sidebar', async () => {
    await renderServer(StaffLayout({ children: page }));
    expect(mocks.userMenu).toHaveBeenCalledWith(
      expect.objectContaining({
        profileHref: '/staff/profile',
        profileLabel: 'Benutzerprofil',
        logoutAction: '/api/staff/force-logout',
      }),
    );
    const sidebar = screen.getByRole('complementary', { name: 'Hauptmenü' });
    const logout = within(sidebar).getByRole('button', { name: 'Abmelden' });
    const form = logout.closest('form')!;
    expect(form.getAttribute('action')).toBe('/api/staff/force-logout');
    expect(form.getAttribute('method')).toBe('post');
  });

  it.each([true, false])(
    'übernimmt den Anzeigemodus %s aus der einen Layout-Transaktion (P-06)',
    async (enabled) => {
      mocks.readStaffLayoutData.mockResolvedValue({
        ...layoutData(enabled),
        notifications: { unread: 0, latestUnreadAt: null },
      });
      await renderServer(StaffLayout({ children: page }));
      expect(mocks.readStaffLayoutData).toHaveBeenCalledOnce();
      expect(mocks.readStaffLayoutData).toHaveBeenCalledWith({
        tenantId: TENANT,
        actorId: STAFF,
        actorType: 'STAFF',
      });
      expect(displayMarker()).toBe(String(enabled));
    },
  );

  it('bindet den Anzeigemodus an das Staff-Profil (Profilwechsel setzt ihn neu auf)', async () => {
    const element = (await StaffLayout({ children: page })) as ReactElement;
    // Ein neuer key erzwingt einen neuen Provider: kein optimistischer Zustand
    // und keine Rückmeldung eines anderen Profils bleiben stehen.
    expect(element.key).toBe(`staff:${TENANT}:${STAFF}`);
  });
});

describe('geschütztes Portal-Layout', () => {
  beforeEach(() => {
    mocks.pathname = '/portal/dashboard';
  });

  it('stellt Skip-Link, Sidebar-Ziel und fokussierbares Main bereit', async () => {
    await renderServer(PortalLayout({ children: page }));
    expectLandmarks();
  });

  it('verlinkt die Einstellungen im Konto-Menü und behält das Abmelden in der Sidebar', async () => {
    await renderServer(PortalLayout({ children: page }));
    expect(mocks.userMenu).toHaveBeenCalledWith(
      expect.objectContaining({
        profileHref: '/portal/settings',
        profileLabel: 'Einstellungen',
        logoutAction: '/api/portal/logout',
      }),
    );
    const sidebar = screen.getByRole('complementary', { name: 'Hauptmenü' });
    const form = within(sidebar).getByRole('button', { name: 'Abmelden' }).closest('form')!;
    expect(form.getAttribute('action')).toBe('/api/portal/logout');
  });

  it.each([true, false])(
    'übernimmt den Anzeigemodus %s aus der einen Layout-Transaktion (P-06)',
    async (enabled) => {
      mocks.readPortalLayoutData.mockResolvedValue({
        ...layoutData(enabled),
        clientName: 'Muster GmbH',
        profiles: [],
      });
      await renderServer(PortalLayout({ children: page }));
      expect(mocks.readPortalLayoutData).toHaveBeenCalledOnce();
      expect(mocks.readPortalLayoutData).toHaveBeenCalledWith(
        { tenantId: TENANT, actorId: CONTACT, actorType: 'CLIENT_CONTACT' },
        { clientId: CLIENT, email: 'max@mandant.example' },
      );
      expect(displayMarker()).toBe(String(enabled));
    },
  );

  it('bindet den Anzeigemodus an das Portalprofil', async () => {
    const element = (await PortalLayout({ children: page })) as ReactElement;
    expect(element.key).toBe(`portal:${TENANT}:${CONTACT}`);
  });
});

describe('Tax-CMS in der Seitenleiste (TCMS Stufe 3)', () => {
  // Fachkatalog: TCMS-DIENST-001
  // Modul an, aber Dienst nicht konfiguriert (TCMS_DEPLOYMENT=disabled): kein
  // Menüpunkt; die Seiten zeigen dann einen Hinweis (server/tcms/seite.ts).
  const mitTcms = { ...layoutData(false), modules: { ...DEFAULT_MODULES, tcms: true } };

  it.each([true, false])('Staff: Menüpunkt nur bei konfiguriertem Dienst (%s)', async (an) => {
    mocks.tcmsKonfiguriert.mockReturnValue(an);
    mocks.readStaffLayoutData.mockResolvedValue({
      ...mitTcms,
      notifications: { unread: 0, latestUnreadAt: null },
    });
    await renderServer(StaffLayout({ children: page }));
    const sidebar = screen.getByRole('complementary', { name: 'Hauptmenü' });
    expect(within(sidebar).queryByRole('link', { name: 'Tax-CMS' }) !== null).toBe(an);
  });

  it.each([true, false])('Portal: Menüpunkt nur bei konfiguriertem Dienst (%s)', async (an) => {
    mocks.pathname = '/portal/dashboard';
    mocks.tcmsKonfiguriert.mockReturnValue(an);
    mocks.readPortalLayoutData.mockResolvedValue({
      ...mitTcms,
      clientName: 'Muster GmbH',
      profiles: [],
    });
    await renderServer(PortalLayout({ children: page }));
    const sidebar = screen.getByRole('complementary', { name: 'Hauptmenü' });
    expect(within(sidebar).queryByRole('link', { name: 'Tax-CMS' }) !== null).toBe(an);
  });
});

describe('Login-Rahmen (AuthShell, R-14)', () => {
  it.each([
    ['Staff', StaffAuthLayout],
    ['Portal', PortalAuthLayout],
  ] as const)(
    '%s-Login nutzt ein fokussierbares Main-Landmark ohne Profil-Anzeigemodus',
    async (_name, Layout) => {
      await renderServer(Layout({ children: page }));
      const main = screen.getByRole('main');
      expect(main.id).toBe('main-content');
      expect(main.getAttribute('tabindex')).toBe('-1');
      expect(within(main).getByText('Seiteninhalt')).toBeTruthy();
      // Außerhalb des Logins gibt es kein Profil: kein AccessibleDisplayProvider.
      expect(displayMarker()).toBeNull();
    },
  );
});
