import type { ReactNode } from 'react';
import { notFound, redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { portalAuth } from '@/server/auth/portal';
import { withTenantContext } from '@taxtronik/db';
import { LogOut } from 'lucide-react';
import { GroupedSidebarNav } from '@/components/sidebar-nav';
import { MobileSidebarToggle } from '@/components/mobile-sidebar-toggle';
import { ThemeToggle } from '@/components/theme-toggle';
import { UiModeToggle } from '@/components/ui-mode-toggle';
import { UserMenu } from '@/components/user-menu';
import { readBranding } from '@/server/settings/branding';
import { readModules } from '@/server/settings/modules';
import { isModuleRouteEnabled } from '@/server/settings/module-route-gate';
import { readPortalFeatures } from '@/server/settings/portal-features';
import { brandPaletteStyle } from '@/lib/brand-palette';
import { TenantLogo } from '@/components/tenant-logo';
import { AutoRefresh } from '@/components/auto-refresh';
import { findPortalProfilesForContact } from '@/server/auth/portal-profiles';
import { PortalProfileSwitcher } from './profile-switcher';
import { resolvePortalNavigation } from '@/lib/navigation-registry';
import { AccessibleDisplayProvider } from '@/components/accessible-display';
import {
  readAccessibleDisplay,
  readAccessibleDisplayOptions,
} from '@/server/settings/accessible-display';
import {
  savePortalAccessibleDisplayAction,
  savePortalAccessibleDisplayOptionsAction,
} from '@/server/actions/accessible-display';

export default async function PortalLayout({ children }: { children: ReactNode }) {
  const session = await portalAuth();
  if (!session?.user) {
    redirect('/portal/login');
  }

  const { tenantId, contactId, clientId } = session.user;

  const [
    client,
    branding,
    modules,
    portalFeatures,
    profiles,
    accessibleDisplay,
    accessibleDisplayOptions,
  ] = await Promise.all([
    withTenantContext({ tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' }, (tx) =>
      tx.client.findUnique({ where: { id: clientId }, select: { name: true } }),
    ),
    readBranding({ tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' }),
    readModules({ tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' }),
    readPortalFeatures({ tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' }),
    findPortalProfilesForContact({ tenantId, contactId }),
    readAccessibleDisplay({ tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' }),
    readAccessibleDisplayOptions({ tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' }),
  ]);

  const navGroups = resolvePortalNavigation({ modules, portalFeatures });

  const pathname = (await headers()).get('x-taxtronik-pathname') ?? '';
  if (!isModuleRouteEnabled(modules, 'portal', pathname)) notFound();

  return (
    <AccessibleDisplayProvider
      key={`portal:${tenantId}:${contactId}`}
      initialEnabled={accessibleDisplay}
      initialOptions={accessibleDisplayOptions}
      saveOptionsAction={savePortalAccessibleDisplayOptionsAction.bind(
        null,
        `portal:${tenantId}:${contactId}`,
      )}
      saveAction={savePortalAccessibleDisplayAction.bind(null, `portal:${tenantId}:${contactId}`)}
    >
      <div
        className="app-shell flex h-screen bg-surface-page"
        style={brandPaletteStyle(branding.accentColor)}
      >
        <a href="#main-content" className="skip-link">
          Zum Hauptinhalt springen
        </a>
        <AutoRefresh />
        <aside
          id="app-sidebar"
          aria-label="Hauptmenü"
          className="app-sidebar w-64 bg-surface-page border-r border-default flex flex-col"
        >
          <div className="h-16 flex flex-col justify-center px-6 border-b border-default">
            {branding.logoDataUrl || branding.logoDataUrlDark ? (
              <TenantLogo
                branding={branding}
                alt={branding.displayName}
                className="h-8 max-w-full object-contain self-start"
              />
            ) : (
              <span className="brand-wordmark text-xl font-bold">{branding.displayName}</span>
            )}
            {branding.subtitle && (
              <span className="text-xs text-muted truncate">{branding.subtitle}</span>
            )}
          </div>

          <div className="px-6 py-4 border-b border-default">
            <p className="eyebrow">Mandant</p>
            <p className="item-title">{client?.name ?? '—'}</p>
            <PortalProfileSwitcher currentContactId={contactId} profiles={profiles} />
          </div>

          <nav aria-label="Hauptnavigation" className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
            <GroupedSidebarNav groups={navGroups} />
          </nav>

          {/* Sidebar-Footer: nur Abmelden — Darstellung sitzt in der Topbar,
            Konto im User-Menü oben rechts. */}
          <div className="p-3 border-t border-default">
            <form action="/api/portal/logout" method="post">
              <button type="submit" className="side-action side-action-danger">
                <LogOut className="h-4 w-4" />
                Abmelden
              </button>
            </form>
          </div>
        </aside>

        {/* relative: absolut positionierte Nachfahren (z. B. sr-only-Labels,
          position:absolute ohne top/left) ankern sonst am Dokument statt am
          Scroll-Container und strecken die Seite um die Content-Höhe —
          sichtbar als endloser leerer Scroll-Bereich unter dem Layout. */}
        <main id="main-content" tabIndex={-1} className="relative flex-1 overflow-auto">
          <div className="h-14 bg-surface-topbar border-b border-default px-4 flex items-center justify-between sticky top-0 z-20">
            <div className="flex items-center gap-3 md:invisible">
              <MobileSidebarToggle />
              <span className="text-sm font-medium text-secondary">{branding.displayName}</span>
            </div>
            <div className="flex items-center gap-1">
              <UiModeToggle />
              <ThemeToggle />
              <span className="topbar-divider" aria-hidden />
              <UserMenu
                name={session.user.fullName}
                email={session.user.email}
                profileHref="/portal/settings"
                profileLabel="Einstellungen"
                logoutAction="/api/portal/logout"
              />
            </div>
          </div>
          {children}
        </main>
      </div>
    </AccessibleDisplayProvider>
  );
}
