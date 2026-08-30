import type { ReactNode } from 'react';
import { notFound, redirect } from 'next/navigation';
import { cookies, headers } from 'next/headers';
import { staffAuth } from '@/server/auth/staff';
import { STAFF_SESSION_COOKIE } from '@/server/auth/session-cookie';
import { isStaffAdmin } from '@/server/auth/rbac';
import { LogOut } from 'lucide-react';
import { SidebarNav, type NavItem } from '@/components/sidebar-nav';
import { GlobalSearch } from '@/components/global-search';
import { NotificationsBellServer } from '@/components/notifications-bell-server';
import { MobileSidebarToggle } from '@/components/mobile-sidebar-toggle';
import { ThemeToggle } from '@/components/theme-toggle';
import { UiModeToggle } from '@/components/ui-mode-toggle';
import { UserMenu } from '@/components/user-menu';
import { readBranding } from '@/server/settings/branding';
import { readModules } from '@/server/settings/modules';
import { isModuleRouteEnabled } from '@/server/settings/module-route-gate';
import { brandPaletteStyle } from '@/lib/brand-palette';
import { TenantLogo } from '@/components/tenant-logo';
import { AutoRefresh } from '@/components/auto-refresh';
import { AccessibleDisplayProvider } from '@/components/accessible-display';
import {
  readAccessibleDisplay,
  readAccessibleDisplayOptions,
} from '@/server/settings/accessible-display';
import {
  saveStaffAccessibleDisplayAction,
  saveStaffAccessibleDisplayOptionsAction,
} from '@/server/actions/accessible-display';

// Vollständige Liste — wird im Layout pro Tenant gefiltert (Module-Toggles).
type ModuleKey =
  | 'bwa'
  | 'knowledge'
  | 'timeTracking'
  | 'phoneNotes'
  | 'taxNotices'
  | 'workflows'
  | 'forms'
  | 'poa'
  | 'reminders'
  | 'invoices';

type NavConfig = NavItem & { moduleKey?: ModuleKey };

const allNavItems: NavConfig[] = [
  { href: '/staff/dashboard', label: 'Dashboard', icon: 'LayoutDashboard' },
  { href: '/staff/clients', label: 'Mandanten', icon: 'Users' },
  { href: '/staff/requests', label: 'Anforderungen', icon: 'Inbox' },
  {
    href: '/staff/workflows',
    label: 'Workflows',
    icon: 'Workflow',
    exact: true,
    moduleKey: 'workflows',
  },
  {
    href: '/staff/calendar',
    label: 'Kanzleikalender',
    icon: 'CalendarDays',
    moduleKey: 'taxNotices',
    altPaths: ['/staff/tax-deadlines'],
  },
  {
    href: '/staff/reminders',
    label: 'Wiedervorlagen',
    icon: 'CalendarClock',
    moduleKey: 'reminders',
  },
  { href: '/staff/fristen', label: 'Fristen', icon: 'AlarmClock' },
  { href: '/staff/invoices', label: 'Rechnungen', icon: 'Receipt', moduleKey: 'invoices' },
  { href: '/staff/poa', label: 'Vollmachten', icon: 'ScrollText', moduleKey: 'poa' },
  { href: '/staff/documents', label: 'Dokumente', icon: 'FileText' },
  { href: '/staff/time', label: 'Zeiterfassung', icon: 'Clock', moduleKey: 'timeTracking' },
  { href: '/staff/absences', label: 'Abwesenheiten', icon: 'Plane' },
  { href: '/staff/phone-notes', label: 'Telefonzettel', icon: 'Phone', moduleKey: 'phoneNotes' },
  { href: '/staff/knowledge', label: 'Wissen', icon: 'BookOpen', moduleKey: 'knowledge' },
  { href: '/staff/reports', label: 'Auswertungen', icon: 'BarChart3', moduleKey: 'bwa' },
];

type AdminNavConfig = NavItem & { moduleKey?: 'workflows' | 'forms' | 'risk' | 'invoices' };

const allAdminNavItems: AdminNavConfig[] = [
  { href: '/staff/admin', label: 'Übersicht', icon: 'Shield', exact: true },
  { href: '/staff/admin/users', label: 'Benutzer', icon: 'Users' },
  { href: '/staff/admin/skills', label: 'Tätigkeiten', icon: 'Tags' },
  {
    href: '/staff/workflows/templates',
    label: 'Workflow-Vorlagen',
    icon: 'Workflow',
    moduleKey: 'workflows',
  },
  { href: '/staff/forms', label: 'Formular-Vorlagen', icon: 'ClipboardList', moduleKey: 'forms' },
  { href: '/staff/admin/request-templates', label: 'Anforderungs-Vorlagen', icon: 'Inbox' },
  { href: '/staff/admin/email-templates', label: 'E-Mail-Vorlagen', icon: 'Mail' },
  {
    href: '/staff/admin/invoice-categories',
    label: 'Rechnungstypen',
    icon: 'Receipt',
    moduleKey: 'invoices',
  },
  { href: '/staff/admin/audit', label: 'Audit-Log', icon: 'Shield' },
  { href: '/staff/admin/quantenlos', label: 'Quantenlos', icon: 'Dices', moduleKey: 'risk' },
  { href: '/staff/admin/archive', label: 'Audit-Archiv', icon: 'Archive' },
  {
    href: '/staff/admin/privacy',
    label: 'Datenschutz',
    icon: 'Shield',
    altPaths: ['/staff/admin/dsgvo', '/staff/admin/dsgvo-retention', '/staff/service-providers'],
  },
  { href: '/staff/admin/settings', label: 'Einstellungen', icon: 'Settings' },
];

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
  const [branding, modules, accessibleDisplay, accessibleDisplayOptions] = await Promise.all([
    readBranding(ctx),
    readModules(ctx),
    readAccessibleDisplay(ctx),
    readAccessibleDisplayOptions(ctx),
  ]);
  const pathname = (await headers()).get('x-taxtronik-pathname') ?? '';
  if (!isModuleRouteEnabled(modules, 'staff', pathname)) notFound();

  const navItems: NavItem[] = allNavItems
    .filter((it) => {
      if (!it.moduleKey) return true;
      if (it.moduleKey === 'poa') return modules.poaMode !== 'OFF';
      if (it.moduleKey === 'invoices') return modules.invoiceMode !== 'OFF';
      return modules[it.moduleKey];
    })
    .map((it) => ({
      href: it.href,
      label: it.label,
      icon: it.icon,
      exact: it.exact,
      altPaths: it.altPaths,
    }));

  const adminNavItems: NavItem[] = allAdminNavItems
    .filter(
      (it) =>
        !it.moduleKey ||
        (it.moduleKey === 'invoices' ? modules.invoiceMode !== 'OFF' : modules[it.moduleKey]),
    )
    .map((it) => ({
      href: it.href,
      label: it.label,
      icon: it.icon,
      exact: it.exact,
      altPaths: it.altPaths,
    }));

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
            <SidebarNav items={navItems} />

            {isAdmin && (
              <div className="pt-3 mt-3 border-t border-default">
                <p className="px-3 text-xs font-medium text-disabled uppercase tracking-wide mb-1">
                  Administration
                </p>
                <SidebarNav items={adminNavItems} />
              </div>
            )}
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
                navItems={[...navItems, ...(isAdmin ? adminNavItems : [])].map((it) => ({
                  label: it.label,
                  href: it.href,
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
