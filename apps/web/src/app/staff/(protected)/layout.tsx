import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
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
import { readBranding } from '@/server/settings/branding';
import { readModules } from '@/server/settings/modules';
import { brandPaletteStyle } from '@/lib/brand-palette';

// Vollständige Liste — wird im Layout pro Tenant gefiltert (Module-Toggles).
type ModuleKey =
  | 'bwa' | 'knowledge' | 'timeTracking' | 'phoneNotes' | 'taxNotices'
  | 'workflows' | 'forms'
  | 'poa' | 'invoices';

type NavConfig = NavItem & { moduleKey?: ModuleKey };

const allNavItems: NavConfig[] = [
  { href: '/staff/dashboard', label: 'Dashboard', icon: 'LayoutDashboard' },
  { href: '/staff/clients', label: 'Mandanten', icon: 'Users' },
  { href: '/staff/requests', label: 'Anforderungen', icon: 'Inbox' },
  { href: '/staff/workflows', label: 'Workflows', icon: 'Workflow', exact: true, moduleKey: 'workflows' },
  { href: '/staff/calendar', label: 'Kanzleikalender', icon: 'CalendarDays', moduleKey: 'taxNotices', altPaths: ['/staff/tax-deadlines'] },
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

type AdminNavConfig = NavItem & { moduleKey?: 'workflows' | 'forms' | 'risk' };

const allAdminNavItems: AdminNavConfig[] = [
  { href: '/staff/admin', label: 'Übersicht', icon: 'Shield', exact: true },
  { href: '/staff/admin/users', label: 'Benutzer', icon: 'Users' },
  { href: '/staff/admin/skills', label: 'Tätigkeiten', icon: 'Tags' },
  { href: '/staff/workflows/templates', label: 'Workflow-Vorlagen', icon: 'Workflow', moduleKey: 'workflows' },
  { href: '/staff/forms', label: 'Formular-Vorlagen', icon: 'ClipboardList', moduleKey: 'forms' },
  { href: '/staff/admin/request-templates', label: 'Anforderungs-Vorlagen', icon: 'Inbox' },
  { href: '/staff/admin/email-templates', label: 'E-Mail-Vorlagen', icon: 'Mail' },
  { href: '/staff/admin/invoice-categories', label: 'Rechnungstypen', icon: 'Receipt' },
  { href: '/staff/admin/audit', label: 'Audit-Log', icon: 'Shield' },
  { href: '/staff/admin/quantenlos', label: 'Quantenlos', icon: 'Dices', moduleKey: 'risk' },
  { href: '/staff/admin/archive', label: 'Audit-Archiv', icon: 'Archive' },
  { href: '/staff/admin/dsgvo', label: 'DSGVO', icon: 'Shield' },
  { href: '/staff/service-providers', label: 'Dienstleister (AVV)', icon: 'Building2' },
  { href: '/staff/admin/settings', label: 'Einstellungen', icon: 'Settings' },
];

export default async function StaffLayout({ children }: { children: React.ReactNode }) {
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
  const [branding, modules] = await Promise.all([readBranding(ctx), readModules(ctx)]);

  const navItems: NavItem[] = allNavItems
    .filter((it) => {
      if (!it.moduleKey) return true;
      if (it.moduleKey === 'poa') return modules.poaMode !== 'OFF';
      if (it.moduleKey === 'invoices') return modules.invoiceMode !== 'OFF';
      return modules[it.moduleKey];
    })
    .map((it) => ({ href: it.href, label: it.label, icon: it.icon, exact: it.exact, altPaths: it.altPaths }));

  const adminNavItems: NavItem[] = allAdminNavItems
    .filter((it) => !it.moduleKey || modules[it.moduleKey])
    .map((it) => ({ href: it.href, label: it.label, icon: it.icon, exact: it.exact, altPaths: it.altPaths }));

  return (
    <div
      className="flex h-screen bg-surface-page"
      style={brandPaletteStyle(branding.accentColor)}
    >
      {/* Sidebar */}
      <aside className="app-sidebar w-64 bg-white dark:bg-gray-900 border-r border-default flex flex-col">
        {/* Logo */}
        <div className="h-16 flex flex-col justify-center px-4 border-b border-default min-w-0">
          {branding.logoDataUrl ? (
            <img
              src={branding.logoDataUrl}
              alt={branding.displayName}
              className="h-9 max-w-full object-contain self-start"
            />
          ) : (
            <span
              className="text-lg font-bold truncate"
              style={{ color: branding.accentColor }}
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
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
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

        {/* User Info + Logout */}
        <div className="p-4 border-t border-default">
          <div className="flex items-center gap-3 mb-3">
            <div className="h-8 w-8 rounded-full bg-brand-100 flex items-center justify-center text-brand-700 text-sm font-semibold">
              {session.user.fullName?.[0]?.toUpperCase() ?? '?'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="item-title">
                {session.user.fullName}
              </p>
              <p className="text-xs text-muted truncate">{session.user.email}</p>
            </div>
          </div>
          <form action="/api/staff/force-logout" method="get">
            <button
              type="submit"
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-secondary hover:text-primary hover:bg-gray-100 rounded-md transition-colors"
            >
              <LogOut className="h-4 w-4" />
              Abmelden
            </button>
          </form>
        </div>
      </aside>

      {/* Hauptinhalt */}
      <main className="flex-1 overflow-auto">
        {/* Header mit Hamburger (mobile) + globaler Suche + Notifications + Theme */}
        <div className="h-14 bg-white dark:bg-gray-900 border-b border-default px-4 md:px-6 flex items-center gap-3 justify-between sticky top-0 z-20">
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
          </div>
        </div>
        {children}
      </main>
    </div>
  );
}
