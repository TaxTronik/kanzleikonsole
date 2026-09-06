import type { BooleanModuleKey, ModuleConfig, ModeModuleKey } from '@/server/settings/modules';
import type { PortalFeatures } from '@/server/settings/portal-features';
import type { NavGroup, NavIcon, NavItem } from '@/components/sidebar-nav';

type Surface = 'staff' | 'portal';
type PortalFeatureKey = keyof PortalFeatures | 'clientInbox';

interface AvailabilityClause {
  allModules?: readonly BooleanModuleKey[];
  anyModules?: readonly BooleanModuleKey[];
  modeModule?: ModeModuleKey;
  permission?: string;
  admin?: boolean;
  portalFeature?: PortalFeatureKey;
}

export interface NavDefinition extends NavItem {
  id: string;
  surface: Surface;
  groupId: string;
  /** OR-Verknuepfte Alternativen; innerhalb einer Klausel gilt AND. */
  availableWhen?: readonly AvailabilityClause[];
  searchAliases?: readonly string[];
}

export interface NavigationAccess {
  modules: ModuleConfig;
  isAdmin?: boolean;
  permissions?: readonly string[];
  portalFeatures?: Partial<Record<PortalFeatureKey, boolean>>;
}

export interface ResolvedNavItem extends NavItem {
  id: string;
  searchAliases?: readonly string[];
}

export interface ResolvedNavGroup extends NavGroup {
  items: ResolvedNavItem[];
}

const GROUPS: Record<Surface, ReadonlyArray<{ id: string; label: string }>> = {
  staff: [
    { id: 'overview', label: 'Übersicht' },
    { id: 'mandates', label: 'Mandatsarbeit' },
    { id: 'communication', label: 'Kommunikation' },
    { id: 'office', label: 'Kanzleiorganisation' },
    { id: 'extensions', label: 'Erweiterungen' },
    { id: 'administration', label: 'Administration' },
  ],
  portal: [
    { id: 'overview', label: 'Übersicht' },
    { id: 'collaboration', label: 'Zusammenarbeit' },
    { id: 'records', label: 'Unterlagen & Finanzen' },
    { id: 'account', label: 'Konto' },
  ],
};

const one = (clause: AvailabilityClause): readonly AvailabilityClause[] => [clause];

const NAVIGATION: readonly NavDefinition[] = [
  // Staff: Übersicht
  {
    id: 'staff-dashboard',
    surface: 'staff',
    groupId: 'overview',
    href: '/staff/dashboard',
    label: 'Dashboard',
    icon: 'LayoutDashboard',
  },
  {
    id: 'staff-work',
    surface: 'staff',
    groupId: 'overview',
    href: '/staff/work',
    label: 'Arbeitskorb',
    icon: 'ListChecks',
    searchAliases: ['Mein Tag', 'Aufgaben'],
  },

  // Staff: Mandatsarbeit
  {
    id: 'staff-clients',
    surface: 'staff',
    groupId: 'mandates',
    href: '/staff/clients',
    label: 'Mandanten',
    icon: 'Users',
  },
  {
    id: 'staff-gwg',
    surface: 'staff',
    groupId: 'mandates',
    href: '/staff/gwg',
    label: 'GwG-Kontrollliste',
    icon: 'IdCard',
  },
  {
    id: 'staff-requests',
    surface: 'staff',
    groupId: 'mandates',
    href: '/staff/requests',
    label: 'Anforderungen',
    icon: 'Inbox',
  },
  {
    id: 'staff-workflows',
    surface: 'staff',
    groupId: 'mandates',
    href: '/staff/workflows',
    label: 'Workflows',
    icon: 'Workflow',
    exact: true,
    availableWhen: one({ allModules: ['workflows'] }),
  },
  {
    id: 'staff-calendar',
    surface: 'staff',
    groupId: 'mandates',
    href: '/staff/calendar',
    label: 'Kanzleikalender',
    icon: 'CalendarDays',
    altPaths: ['/staff/tax-deadlines'],
    availableWhen: one({ allModules: ['taxNotices'] }),
  },
  {
    id: 'staff-reminders',
    surface: 'staff',
    groupId: 'mandates',
    href: '/staff/reminders',
    label: 'Wiedervorlagen',
    icon: 'CalendarClock',
    availableWhen: one({ allModules: ['reminders'] }),
  },
  {
    id: 'staff-deadlines',
    surface: 'staff',
    groupId: 'mandates',
    href: '/staff/fristen',
    label: 'Fristen',
    icon: 'AlarmClock',
  },

  // Staff: Kommunikation
  {
    id: 'staff-portal-inbox',
    surface: 'staff',
    groupId: 'communication',
    href: '/staff/inbox',
    label: 'Mandantenpost',
    icon: 'Inbox',
    availableWhen: one({
      permission: 'PORTAL_INBOX_MANAGE',
      portalFeature: 'clientInbox',
    }),
  },
  {
    id: 'staff-phone-notes',
    surface: 'staff',
    groupId: 'communication',
    href: '/staff/phone-notes',
    label: 'Telefonzettel',
    icon: 'Phone',
    availableWhen: one({ allModules: ['phoneNotes'] }),
  },

  // Staff: Kanzleiorganisation
  {
    id: 'staff-invoices',
    surface: 'staff',
    groupId: 'office',
    href: '/staff/invoices',
    label: 'Rechnungen',
    icon: 'Receipt',
    availableWhen: one({ modeModule: 'invoices' }),
  },
  {
    id: 'staff-poa',
    surface: 'staff',
    groupId: 'office',
    href: '/staff/poa',
    label: 'Vollmachten',
    icon: 'ScrollText',
    availableWhen: one({ modeModule: 'poa' }),
  },
  {
    id: 'staff-documents',
    surface: 'staff',
    groupId: 'office',
    href: '/staff/documents',
    label: 'Dokumente',
    icon: 'FileText',
  },
  {
    id: 'staff-time',
    surface: 'staff',
    groupId: 'office',
    href: '/staff/time',
    label: 'Zeiterfassung',
    icon: 'Clock',
    availableWhen: one({ allModules: ['timeTracking'] }),
  },
  {
    id: 'staff-absences',
    surface: 'staff',
    groupId: 'office',
    href: '/staff/absences',
    label: 'Abwesenheiten',
    icon: 'Plane',
  },
  {
    id: 'staff-knowledge',
    surface: 'staff',
    groupId: 'office',
    href: '/staff/knowledge',
    label: 'Wissen',
    icon: 'BookOpen',
    availableWhen: one({ allModules: ['knowledge'] }),
  },
  {
    id: 'staff-reports',
    surface: 'staff',
    groupId: 'office',
    href: '/staff/reports',
    label: 'Auswertungen',
    icon: 'BarChart3',
    availableWhen: one({ allModules: ['bwa'] }),
  },

  // Staff: Erweiterungen. Geteilte Ziele tragen absichtlich EIN kanonisches Label.
  {
    id: 'staff-knowledge-context',
    surface: 'staff',
    groupId: 'extensions',
    href: '/staff/knowledge/context',
    label: 'Wiki im Bearbeitungskontext',
    icon: 'BookOpen',
    availableWhen: one({ allModules: ['knowledge', 'knowledgeContext'] }),
  },
  {
    id: 'staff-year-end',
    surface: 'staff',
    groupId: 'extensions',
    href: '/staff/year-end',
    label: 'Jahreswechselkampagnen',
    icon: 'ClipboardList',
    availableWhen: one({ allModules: ['yearEndCampaigns'] }),
  },
  {
    id: 'staff-interactions',
    surface: 'staff',
    groupId: 'extensions',
    href: '/staff/interactions',
    label: 'Mandantenentscheidungen und Feedback',
    icon: 'Inbox',
    availableWhen: one({ anyModules: ['noticeDecisions', 'feedbackSurveys'] }),
  },
  {
    id: 'staff-mailbox',
    surface: 'staff',
    groupId: 'extensions',
    href: '/staff/mailbox',
    label: 'Smart-Mailbox',
    icon: 'Mail',
    availableWhen: one({ allModules: ['smartMailbox'], permission: 'INBOUND_MAIL_MANAGE' }),
  },
  {
    id: 'staff-payroll',
    surface: 'staff',
    groupId: 'extensions',
    href: '/staff/payroll',
    label: 'Personalfragebogen',
    icon: 'ClipboardList',
    availableWhen: one({ allModules: ['payrollIntake'], permission: 'PAYROLL_MANAGE' }),
  },
  {
    id: 'staff-client-assistance',
    surface: 'staff',
    groupId: 'extensions',
    href: '/staff/client-assistance',
    label: 'Mandanten-Assistenten',
    icon: 'ClipboardList',
    availableWhen: one({ anyModules: ['expenseAssistance', 'clientProcedures'] }),
  },
  {
    id: 'staff-mandate-expansion',
    surface: 'staff',
    groupId: 'extensions',
    href: '/staff/mandate-expansion',
    label: 'Mandatsorganisation',
    icon: 'Workflow',
    availableWhen: [
      { allModules: ['mandateStructure'] },
      { allModules: ['workflowDependencies'] },
      { allModules: ['vdbPreparation'] },
      { allModules: ['mandateOffboarding'], admin: true },
    ],
  },
  {
    id: 'staff-screening',
    surface: 'staff',
    groupId: 'extensions',
    href: '/staff/admin/screening',
    label: 'Sanktions- und PEP-Prüfung',
    icon: 'Shield',
    availableWhen: one({ allModules: ['sanctionsScreening'], admin: true }),
  },
  {
    id: 'staff-stbvv',
    surface: 'staff',
    groupId: 'extensions',
    href: '/staff/stbvv',
    label: 'StBVV-Honorarvorschläge',
    icon: 'Receipt',
    availableWhen: one({ allModules: ['feeCalculator'] }),
  },

  // Staff: Administration
  ...(
    [
      ['staff-admin', '/staff/admin', 'Übersicht', 'Shield', undefined, true],
      ['staff-admin-users', '/staff/admin/users', 'Benutzer', 'Users'],
      ['staff-admin-skills', '/staff/admin/skills', 'Tätigkeiten', 'Tags'],
      [
        'staff-workflow-templates',
        '/staff/workflows/templates',
        'Workflow-Vorlagen',
        'Workflow',
        'workflows',
      ],
      ['staff-form-templates', '/staff/forms', 'Formular-Vorlagen', 'ClipboardList', 'forms'],
      [
        'staff-request-templates',
        '/staff/admin/request-templates',
        'Anforderungs-Vorlagen',
        'Inbox',
      ],
      ['staff-email-templates', '/staff/admin/email-templates', 'E-Mail-Vorlagen', 'Mail'],
      [
        'staff-invoice-categories',
        '/staff/admin/invoice-categories',
        'Rechnungstypen',
        'Receipt',
        'invoices',
      ],
      ['staff-admin-audit', '/staff/admin/audit', 'Audit-Log', 'Shield'],
      ['staff-admin-risk', '/staff/admin/quantenlos', 'Quantenlos', 'Dices', 'risk'],
      ['staff-admin-archive', '/staff/admin/archive', 'Audit-Archiv', 'Archive'],
      ['staff-admin-privacy', '/staff/admin/privacy', 'Datenschutz', 'Shield'],
      ['staff-admin-settings', '/staff/admin/settings', 'Einstellungen', 'Settings'],
    ] as const
  ).map(([id, href, label, icon, module, exact]) => ({
    id,
    surface: 'staff' as const,
    groupId: 'administration',
    href,
    label,
    icon: icon as NavIcon,
    exact,
    altPaths:
      id === 'staff-admin-privacy'
        ? ['/staff/admin/dsgvo', '/staff/admin/dsgvo-retention', '/staff/service-providers']
        : undefined,
    availableWhen: one({
      admin: true,
      ...(module === 'invoices'
        ? { modeModule: 'invoices' as const }
        : module
          ? { allModules: [module] as BooleanModuleKey[] }
          : {}),
    }),
  })),

  // Portal
  {
    id: 'portal-dashboard',
    surface: 'portal',
    groupId: 'overview',
    href: '/portal/dashboard',
    label: 'Übersicht',
    icon: 'LayoutDashboard',
  },
  {
    id: 'portal-requests',
    surface: 'portal',
    groupId: 'collaboration',
    href: '/portal/requests',
    label: 'Anforderungen',
    icon: 'Inbox',
  },
  {
    id: 'portal-inbox',
    surface: 'portal',
    groupId: 'collaboration',
    href: '/portal/inbox',
    label: 'Nachrichten',
    icon: 'Mail',
    availableWhen: one({ portalFeature: 'clientInbox' }),
  },
  {
    id: 'portal-forms',
    surface: 'portal',
    groupId: 'collaboration',
    href: '/portal/forms',
    label: 'Formulare',
    icon: 'ClipboardList',
    availableWhen: one({ allModules: ['forms'] }),
  },
  {
    id: 'portal-appointments',
    surface: 'portal',
    groupId: 'collaboration',
    href: '/portal/appointments',
    label: 'Termine',
    icon: 'CalendarDays',
    availableWhen: one({ allModules: ['appointments'] }),
  },
  {
    id: 'portal-client-assistance',
    surface: 'portal',
    groupId: 'collaboration',
    href: '/portal/client-assistance',
    label: 'Belege und Verfahren',
    icon: 'ClipboardList',
    availableWhen: one({ anyModules: ['expenseAssistance', 'clientProcedures'] }),
  },
  {
    id: 'portal-interactions',
    surface: 'portal',
    groupId: 'collaboration',
    href: '/portal/interactions',
    label: 'Entscheidungen und Feedback',
    icon: 'Inbox',
    availableWhen: one({ anyModules: ['noticeDecisions', 'feedbackSurveys'] }),
  },
  {
    id: 'portal-payroll',
    surface: 'portal',
    groupId: 'collaboration',
    href: '/portal/payroll',
    label: 'Personalvorgänge',
    icon: 'ClipboardList',
    availableWhen: one({ allModules: ['payrollIntake'] }),
  },
  {
    id: 'portal-handovers',
    surface: 'portal',
    groupId: 'records',
    href: '/portal/handovers',
    label: 'Hinterlegt',
    icon: 'Inbox',
    availableWhen: one({ allModules: ['handovers'], portalFeature: 'handoversView' }),
  },
  {
    id: 'portal-bwa',
    surface: 'portal',
    groupId: 'records',
    href: '/portal/bwa',
    label: 'Auswertungen',
    icon: 'BarChart3',
    availableWhen: one({ allModules: ['bwa'], portalFeature: 'bwaView' }),
  },
  {
    id: 'portal-tax',
    surface: 'portal',
    groupId: 'records',
    href: '/portal/steuer',
    label: 'Steuererklärungen',
    icon: 'ScrollText',
    availableWhen: one({ allModules: ['taxNotices'] }),
  },
  {
    id: 'portal-invoices',
    surface: 'portal',
    groupId: 'records',
    href: '/portal/invoices',
    label: 'Rechnungen',
    icon: 'Receipt',
    availableWhen: one({ modeModule: 'invoices' }),
  },
  {
    id: 'portal-documents',
    surface: 'portal',
    groupId: 'records',
    href: '/portal/documents',
    label: 'Dokumente',
    icon: 'FileText',
  },
  {
    id: 'portal-master-data',
    surface: 'portal',
    groupId: 'account',
    href: '/portal/stammdaten',
    label: 'Stammdaten',
    icon: 'IdCard',
    availableWhen: one({ portalFeature: 'stammdatenSelfService' }),
  },
  {
    id: 'portal-settings',
    surface: 'portal',
    groupId: 'account',
    href: '/portal/settings',
    label: 'Einstellungen',
    icon: 'Settings',
  },
];

function clauseMatches(clause: AvailabilityClause, access: NavigationAccess): boolean {
  if (clause.admin && !access.isAdmin) return false;
  if (clause.permission && !access.isAdmin && !access.permissions?.includes(clause.permission))
    return false;
  if (clause.allModules?.some((key) => !access.modules[key])) return false;
  if (clause.anyModules && !clause.anyModules.some((key) => access.modules[key])) return false;
  if (clause.modeModule === 'poa' && access.modules.poaMode === 'OFF') return false;
  if (clause.modeModule === 'invoices' && access.modules.invoiceMode === 'OFF') return false;
  if (clause.portalFeature && access.portalFeatures?.[clause.portalFeature] !== true) return false;
  return true;
}

function resolveNavigation(surface: Surface, access: NavigationAccess): ResolvedNavGroup[] {
  const definitions = NAVIGATION.filter(
    (item) =>
      item.surface === surface &&
      (!item.availableWhen || item.availableWhen.some((clause) => clauseMatches(clause, access))),
  );
  return GROUPS[surface]
    .map((group) => ({
      ...group,
      items: definitions
        .filter((item) => item.groupId === group.id)
        .map(({ id, href, label, icon, exact, altPaths, searchAliases }) => ({
          id,
          href,
          label,
          icon,
          exact,
          altPaths,
          searchAliases,
        })),
    }))
    .filter((group) => group.items.length > 0);
}

export function resolveStaffNavigation(access: NavigationAccess): ResolvedNavGroup[] {
  return resolveNavigation('staff', access);
}

export function resolvePortalNavigation(access: NavigationAccess): ResolvedNavGroup[] {
  return resolveNavigation('portal', access);
}

export interface MandateExpansionItem {
  id: string;
  href: string;
  label: string;
  title: string;
  description: string;
}

const MANDATE_EXPANSION_ITEMS = [
  {
    id: 'structure',
    module: 'mandateStructure',
    href: '/staff/mandate-expansion/structure',
    label: 'Beteiligungsstruktur',
    title: 'Mandanten- und Beteiligungsstruktur',
    description:
      'Direkte Beteiligungen als versionierte Grafik und Tabelle dokumentieren; PDF für die Akte.',
  },
  {
    id: 'dependencies',
    module: 'workflowDependencies',
    href: '/staff/mandate-expansion/dependencies',
    label: 'Abhängigkeiten',
    title: 'Mandatsübergreifende Abhängigkeiten',
    description:
      'Workflow-Schritte ausdrücklich verbinden und Bereitschaft aus Vorgängern erkennen.',
  },
  {
    id: 'offboarding',
    module: 'mandateOffboarding',
    admin: true,
    href: '/staff/mandate-expansion/offboarding',
    label: 'Mandatsübergabe',
    title: 'Mandatsübergabe',
    description:
      'Herausgabeauswahl, offene Fristen und Aufbewahrungsprüfung vor der Zugangssperre dokumentieren.',
  },
  {
    id: 'vdb',
    module: 'vdbPreparation',
    href: '/staff/mandate-expansion/vdb',
    label: 'VDB-Nachweise',
    title: 'VDB-Vorbereitung und Nachweise',
    description:
      'Externe Meldeschritte mit Dokumentnachweis festhalten. Kein ungeprüfter VDB-Importexport.',
  },
] as const;

export function resolveMandateExpansionItems(
  modules: ModuleConfig,
  isAdmin: boolean,
): MandateExpansionItem[] {
  return MANDATE_EXPANSION_ITEMS.filter(
    (item) => modules[item.module] && (!('admin' in item) || !item.admin || isAdmin),
  ).map(({ id, href, label, title, description }) => ({ id, href, label, title, description }));
}
