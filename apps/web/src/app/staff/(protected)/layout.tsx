import type { ReactNode } from 'react';
import { notFound, redirect } from 'next/navigation';
import { cookies, headers } from 'next/headers';
import { staffAuth } from '@/server/auth/staff';
import { STAFF_SESSION_COOKIE } from '@/server/auth/session-cookie';
import { isStaffAdmin } from '@/server/auth/rbac';
import { LogOut } from 'lucide-react';
import { GroupedSidebarNav } from '@/components/sidebar-nav';
import { GlobalSearch } from '@/components/global-search';
import { NotificationsBellServer } from '@/components/notifications-bell-server';
import { MobileSidebarToggle } from '@/components/mobile-sidebar-toggle';
import { ThemeToggle } from '@/components/theme-toggle';
import { UiModeToggle } from '@/components/ui-mode-toggle';
import { UserMenu } from '@/components/user-menu';
import { readBranding } from '@/server/settings/branding';
import { readModules } from '@/server/settings/modules';
import { readPortalFeatures } from '@/server/settings/portal-features';
import { isModuleRouteEnabled } from '@/server/settings/module-route-gate';
import { brandPaletteStyle } from '@/lib/brand-palette';
import { TenantLogo } from '@/components/tenant-logo';
import { AutoRefresh } from '@/components/auto-refresh';
import { resolveStaffNavigation } from '@/lib/navigation-registry';
import { AccessibleDisplayProvider } from '@/components/accessible-display';
import {
  readAccessibleDisplay,
  readAccessibleDisplayOptions,
} from '@/server/settings/accessible-display';
import {
  saveStaffAccessibleDisplayAction,
  saveStaffAccessibleDisplayOptionsAction,
} from '@/server/actions/accessible-display';

export default async function StaffLayout({ children }: { children: ReactNode }) {
  const session = await staffAuth();
  if (!session?.user) {
    // Liegt ein (ungültiges/Geister-)Session-Cookie vor, aber staffAuth lieferte
    // null? Dann das tote Cookie aktiv löschen (force-logout), statt es bei jedem
    // Request erneut abzuweisen — sonst kann sich ein Browser darauf verklemmen.
    // Kein Cookie → direkt zum Login (kein unnötiger Umweg).
    const hasSessionCookie = (await cookies())
      .getAll()
      .some((c) => c.name.startsWith(STAFF_SESSION_COOKIE));
    redirect(hasSessionCookie ? '/api/staff/force-logout' : '/staff/login');
  }

  const isAdmin = isStaffAdmin(session);
  const ctx = {
    tenantId: session.user.tenantId,
    actorId: session.user.staffId,
    actorType: 'STAFF' as const,
  };
  const [branding, modules, portalFeatures, accessibleDisplay, accessibleDisplayOptions] =
    await Promise.all([
      readBranding(ctx),
      readModules(ctx),
      readPortalFeatures(ctx),
      readAccessibleDisplay(ctx),
      readAccessibleDisplayOptions(ctx),
    ]);
  const pathname = (await headers()).get('x-taxtronik-pathname') ?? '';
  if (!isModuleRouteEnabled(modules, 'staff', pathname)) notFound();

  const navGroups = resolveStaffNavigation({
    modules,
    isAdmin,
    permissions: session.user.permissions,
    portalFeatures,
  });

  return (
    <AccessibleDisplayProvider
      key={`staff:${ctx.tenantId}:${ctx.actorId}`}
      initialEnabled={accessibleDisplay}
      initialOptions={accessibleDisplayOptions}
      saveOptionsAction={saveStaffAccessibleDisplayOptionsAction.bind(
        null,
        `staff:${ctx.tenantId}:${ctx.actorId}`,
      )}
      saveAction={saveStaffAccessibleDisplayAction.bind(
        null,
        `staff:${ctx.tenantId}:${ctx.actorId}`,
      )}
    >
      <div
        className="app-shell flex h-screen bg-surface-page"
        style={brandPaletteStyle(branding.accentColor)}
      >
        <a href="#main-content" className="skip-link">
          Zum Hauptinhalt springen
        </a>
        <AutoRefresh />
        {/* Sidebar */}
        <aside
          id="app-sidebar"
          aria-label="Hauptmenü"
          className="app-sidebar w-64 bg-surface-page border-r border-default flex flex-col"
        >
          {/* Logo */}
          <div className="h-16 flex flex-col justify-center px-4 border-b border-default min-w-0">
            {branding.logoDataUrl || branding.logoDataUrlDark ? (
              <TenantLogo
                branding={branding}
                alt={branding.displayName}
                className="h-8 max-w-full object-contain self-start"
              />
            ) : (
              <span
                className="brand-wordmark text-lg font-bold truncate"
                title={branding.displayName}
              >
                {branding.displayName}
              </span>
            )}
            {branding.subtitle && (
              <span className="text-xs text-muted truncate">{branding.subtitle}</span>
            )}
          </div>

          {/* Navigation */}
          <nav aria-label="Hauptnavigation" className="flex-1 px-3 py-4 overflow-y-auto">
            <GroupedSidebarNav groups={navGroups} />
          </nav>

          {/* Sidebar-Footer: nur Abmelden — Konto/Profil lebt im User-Menü
            oben rechts in der Topbar. */}
          <div className="p-3 border-t border-default">
            <form action="/api/staff/force-logout" method="post">
              <button type="submit" className="side-action side-action-danger">
                <LogOut className="h-4 w-4" />
                Abmelden
              </button>
            </form>
          </div>
        </aside>

        {/* Hauptinhalt */}
        {/* relative: absolut positionierte Nachfahren (z. B. sr-only-Labels,
          position:absolute ohne top/left) ankern sonst am Dokument statt am
          Scroll-Container und strecken die Seite um die Content-Höhe —
          sichtbar als endloser leerer Scroll-Bereich unter dem Layout. */}
        <main id="main-content" tabIndex={-1} className="relative flex-1 overflow-auto">
          {/* Header mit Hamburger (mobile) + globaler Suche + Notifications + Theme */}
          <div className="h-14 bg-surface-topbar border-b border-default px-4 md:px-6 flex items-center gap-3 justify-between sticky top-0 z-20">
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <MobileSidebarToggle />
              <GlobalSearch
                navItems={navGroups
                  .flatMap((group) => group.items)
                  .map((it) => ({
                    label: it.label,
                    href: it.href,
                    aliases: it.searchAliases,
                  }))}
              />
            </div>
            <div className="flex items-center gap-1">
              <UiModeToggle />
              <ThemeToggle />
              <NotificationsBellServer />
              <span className="topbar-divider" aria-hidden />
              <UserMenu
                name={session.user.fullName}
                email={session.user.email}
                profileHref="/staff/profile"
                profileLabel="Benutzerprofil"
                logoutAction="/api/staff/force-logout"
              />
            </div>
          </div>
          {children}
        </main>
      </div>
    </AccessibleDisplayProvider>
  );
}
