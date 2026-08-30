import type { ReactNode } from 'react';
import { notFound, redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { portalAuth } from '@/server/auth/portal';
import { withTenantContext } from '@taxtronik/db';
import { LogOut } from 'lucide-react';
import { SidebarNav, type NavItem } from '@/components/sidebar-nav';
import { MobileSidebarToggle } from '@/components/mobile-sidebar-toggle';
import { ThemeToggle } from '@/components/theme-toggle';
import { UiModeToggle } from '@/components/ui-mode-toggle';
import { UserMenu } from '@/components/user-menu';
import { readBranding } from '@/server/settings/branding';
import { readModules } from '@/server/settings/modules';
import { isModuleRouteEnabled } from '@/server/settings/module-route-gate';
import { readPortalFeatures, type PortalFeatures } from '@/server/settings/portal-features';
import { brandPaletteStyle } from '@/lib/brand-palette';
import { TenantLogo } from '@/components/tenant-logo';
import { AutoRefresh } from '@/components/auto-refresh';
import { findPortalProfilesForContact } from '@/server/auth/portal-profiles';
import { PortalProfileSwitcher } from './profile-switcher';
import { AccessibleDisplayProvider } from '@/components/accessible-display';
import {
  readAccessibleDisplay,
  readAccessibleDisplayOptions,
} from '@/server/settings/accessible-display';
import {
  savePortalAccessibleDisplayAction,
  savePortalAccessibleDisplayOptionsAction,
} from '@/server/actions/accessible-display';

// Tenant-weite Module-Toggles steuern, ob das gesamte Feature aktiv ist
// (Staff + Portal). Portal-Feature-Toggles erlauben darüber hinaus, einzelne
// Bereiche speziell im Mandantenportal auszublenden — z. B. BWA-Ansicht
// behalten, aber Mandanten-Planung sperren.
type PortalModuleKey = 'forms' | 'appointments' | 'handovers' | 'bwa' | 'taxNotices' | 'invoices';

type PortalNavConfig = NavItem & {
  moduleKey?: PortalModuleKey;
  portalFeature?: keyof PortalFeatures;
};

const allPortalNavItems: PortalNavConfig[] = [
  { href: '/portal/dashboard', label: 'Übersicht', icon: 'LayoutDashboard' },
  { href: '/portal/requests', label: 'Anforderungen', icon: 'Inbox' },
  { href: '/portal/forms', label: 'Formulare', icon: 'ClipboardList', moduleKey: 'forms' },
  {
    href: '/portal/appointments',
    label: 'Termine',
    icon: 'CalendarDays',
    moduleKey: 'appointments',
  },
  {
    href: '/portal/handovers',
    label: 'Hinterlegt',
    icon: 'Inbox',
    moduleKey: 'handovers',
    portalFeature: 'handoversView',
  },
  {
    href: '/portal/bwa',
    label: 'Auswertungen',
    icon: 'BarChart3',
    moduleKey: 'bwa',
    portalFeature: 'bwaView',
  },
  {
    href: '/portal/steuer',
    label: 'Steuererklärungen',
    icon: 'ScrollText',
    moduleKey: 'taxNotices',
  },
  { href: '/portal/invoices', label: 'Rechnungen', icon: 'Receipt', moduleKey: 'invoices' },
  { href: '/portal/documents', label: 'Dokumente', icon: 'FileText' },
  {
    href: '/portal/stammdaten',
    label: 'Stammdaten',
    icon: 'IdCard',
    portalFeature: 'stammdatenSelfService',
  },
  { href: '/portal/settings', label: 'Einstellungen', icon: 'Settings' },
];

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

  const navItems: NavItem[] = allPortalNavItems
    .filter((it) => {
      const moduleEnabled =
        !it.moduleKey ||
        (it.moduleKey === 'invoices' ? modules.invoiceMode !== 'OFF' : modules[it.moduleKey]);
      const portalFeatureEnabled = !it.portalFeature || portalFeatures[it.portalFeature];
      return moduleEnabled && portalFeatureEnabled;
    })
    .map((it) => ({ href: it.href, label: it.label, icon: it.icon, exact: it.exact }));

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

          <nav aria-label="Hauptnavigation" className="flex-1 px-3 py-4">
            <SidebarNav items={navItems} />
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
