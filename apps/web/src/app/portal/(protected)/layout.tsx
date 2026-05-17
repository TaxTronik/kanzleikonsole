import { redirect } from 'next/navigation';
import { portalAuth } from '@/server/auth/portal';
import { withTenantContext } from '@taxtronik/db';
import { LogOut } from 'lucide-react';
import { SidebarNav, type NavItem } from '@/components/sidebar-nav';
import { MobileSidebarToggle } from '@/components/mobile-sidebar-toggle';
import { ThemeToggle } from '@/components/theme-toggle';
import { UiModeToggle } from '@/components/ui-mode-toggle';
import { readBranding } from '@/server/settings/branding';
import { readModules } from '@/server/settings/modules';
import { readPortalFeatures, type PortalFeatures } from '@/server/settings/portal-features';
import { brandPaletteStyle } from '@/lib/brand-palette';

// Tenant-weite Module-Toggles steuern, ob das gesamte Feature aktiv ist
// (Staff + Portal). Portal-Feature-Toggles erlauben darüber hinaus, einzelne
// Bereiche speziell im Mandantenportal auszublenden — z. B. BWA-Ansicht
// behalten, aber Mandanten-Planung sperren.
type PortalModuleKey =
  | 'forms' | 'appointments' | 'handovers' | 'bwa' | 'taxNotices' | 'invoices';

type PortalNavConfig = NavItem & {
  moduleKey?: PortalModuleKey;
  portalFeature?: keyof PortalFeatures;
};

const allPortalNavItems: PortalNavConfig[] = [
  { href: '/portal/dashboard', label: 'Übersicht', icon: 'LayoutDashboard' },
  { href: '/portal/requests', label: 'Anforderungen', icon: 'Inbox' },
  { href: '/portal/forms', label: 'Formulare', icon: 'ClipboardList', moduleKey: 'forms' },
  { href: '/portal/appointments', label: 'Termine', icon: 'CalendarDays', moduleKey: 'appointments' },
  { href: '/portal/handovers', label: 'Hinterlegt', icon: 'Inbox', moduleKey: 'handovers', portalFeature: 'handoversView' },
  { href: '/portal/bwa', label: 'Auswertungen', icon: 'BarChart3', moduleKey: 'bwa', portalFeature: 'bwaView' },
  { href: '/portal/steuer', label: 'Steuererklärungen', icon: 'ScrollText', moduleKey: 'taxNotices' },
  { href: '/portal/invoices', label: 'Rechnungen', icon: 'Receipt', moduleKey: 'invoices' },
  { href: '/portal/documents', label: 'Dokumente', icon: 'FileText' },
  { href: '/portal/stammdaten', label: 'Stammdaten', icon: 'IdCard', portalFeature: 'stammdatenSelfService' },
  { href: '/portal/settings', label: 'Einstellungen', icon: 'Settings' },
];

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const session = await portalAuth();
  if (!session?.user) {
    redirect('/portal/login');
  }

  const { tenantId, contactId, clientId } = session.user;

  const [client, branding, modules, portalFeatures] = await Promise.all([
    withTenantContext(
      { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' },
      (tx) => tx.client.findUnique({ where: { id: clientId }, select: { name: true } }),
    ),
    readBranding({ tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' }),
    readModules({ tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' }),
    readPortalFeatures({ tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' }),
  ]);

  const navItems: NavItem[] = allPortalNavItems
    .filter((it) => {
      if (it.moduleKey) {
        if (it.moduleKey === 'invoices') {
          if (modules.invoiceMode === 'OFF') return false;
        } else if (!modules[it.moduleKey]) {
          return false;
        }
      }
      if (it.portalFeature && !portalFeatures[it.portalFeature]) return false;
      return true;
    })
    .map((it) => ({ href: it.href, label: it.label, icon: it.icon, exact: it.exact }));

  return (
    <div
      className="flex h-screen bg-gray-50 dark:bg-gray-950"
      style={brandPaletteStyle(branding.accentColor)}
    >
      <aside className="app-sidebar w-64 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 flex flex-col">
        <div className="h-16 flex flex-col justify-center px-6 border-b border-gray-200 dark:border-gray-800">
          {branding.logoDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={branding.logoDataUrl}
              alt={branding.displayName}
              className="h-9 max-w-full object-contain self-start"
            />
          ) : (
            <span className="text-xl font-bold" style={{ color: branding.accentColor }}>
              {branding.displayName}
            </span>
          )}
          {branding.subtitle && (
            <span className="text-xs text-gray-500 truncate">{branding.subtitle}</span>
          )}
        </div>

        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-800">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Mandant</p>
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{client?.name ?? '—'}</p>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1">
          <SidebarNav items={navItems} />
        </nav>

        <div className="p-4 border-t border-gray-200 dark:border-gray-800">
          <div className="flex items-center gap-3 mb-3">
            <div className="h-8 w-8 rounded-full bg-brand-100 flex items-center justify-center text-brand-700 text-sm font-semibold">
              {session.user.fullName?.[0]?.toUpperCase() ?? '?'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{session.user.fullName}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{session.user.email}</p>
            </div>
          </div>
          <div className="flex items-center justify-between mb-2 px-1">
            <span className="text-xs text-gray-500 dark:text-gray-400">Darstellung</span>
            <div className="flex items-center gap-0.5">
              <UiModeToggle />
              <ThemeToggle />
            </div>
          </div>
          <form
            action={async () => {
              'use server';
              const { portalSignOut } = await import('@/server/auth/portal');
              await portalSignOut({ redirectTo: '/portal/login' });
            }}
          >
            <button
              type="submit"
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-300 dark:hover:text-gray-100 dark:hover:bg-gray-800 rounded-md transition-colors"
            >
              <LogOut className="h-4 w-4" />
              Abmelden
            </button>
          </form>
        </div>
      </aside>

      <main className="flex-1 overflow-auto">
        <div className="h-14 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-4 flex items-center justify-between sticky top-0 z-20">
          <div className="flex items-center gap-3 md:invisible">
            <MobileSidebarToggle />
            <span className="text-sm font-medium text-gray-700 dark:text-gray-200">{branding.displayName}</span>
          </div>
          <div className="flex items-center gap-1">
            <UiModeToggle />
            <ThemeToggle />
          </div>
        </div>
        {children}
      </main>
    </div>
  );
}
