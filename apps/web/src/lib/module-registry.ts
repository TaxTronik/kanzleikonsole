// =============================================================================
// Modul-Registry: EINE Zuordnung Seitenpfad → Modulanforderung.
//
// Quelle für
// - das Layout-Gate (server/settings/module-route-gate.ts),
// - die Navigation (lib/navigation-registry.ts: Seitenleiste, Mandanten-
//   Reiter, Mandatsorganisation) und
// - den Seiten-Helper requireModulePage() (server/settings/module-page.ts).
//
// Pfadmuster: `[x]` steht für genau ein dynamisches Segment; Unterpfade erben
// die Anforderung. Bei mehreren Treffern gilt das spezifischste Muster (meiste
// Segmente), unabhängig von der Reihenfolge.
// Nur Typ-Importe: die Registry ist rein und ohne DB nutzbar.
// =============================================================================

import type { BooleanModuleKey, ModeModuleKey, ModuleConfig } from '@/server/settings/modules';

export type ModuleSurface = 'staff' | 'portal';

export interface ModuleRequirement {
  /** Alle genannten Module müssen aktiv sein. */
  all?: readonly BooleanModuleKey[];
  /** Mindestens eines der genannten Module muss aktiv sein. */
  any?: readonly BooleanModuleKey[];
  /** Spezialmodule, deren Betriebsmodus nicht OFF sein darf. */
  modes?: readonly ModeModuleKey[];
}

export interface ModuleArea {
  requires: ModuleRequirement;
  /** Seitenpfade (Staff und Portal), die diese Anforderung tragen. */
  paths: readonly string[];
}

export const MODULE_AREAS = {
  interactions: {
    requires: { any: ['noticeDecisions', 'feedbackSurveys'] },
    paths: ['/staff/interactions', '/portal/interactions'],
  },
  knowledge: { requires: { all: ['knowledge'] }, paths: ['/staff/knowledge'] },
  knowledgeContext: {
    requires: { all: ['knowledge', 'knowledgeContext'] },
    paths: ['/staff/knowledge/context'],
  },
  smartMailbox: { requires: { all: ['smartMailbox'] }, paths: ['/staff/mailbox'] },
  payrollIntake: {
    requires: { all: ['payrollIntake'] },
    paths: ['/staff/payroll', '/portal/payroll'],
  },
  clientAssistance: {
    requires: { any: ['expenseAssistance', 'clientProcedures'] },
    paths: ['/staff/client-assistance', '/portal/client-assistance'],
  },
  // Jahreswechselkampagnen verteilen eingefrorene Formular-Checklisten.
  yearEndCampaigns: {
    requires: { all: ['yearEndCampaigns', 'forms'] },
    paths: ['/staff/year-end'],
  },
  // Hub der Mandatsorganisation; die Unterseiten verlangen ihr eigenes Modul.
  mandateExpansion: {
    requires: {
      any: ['mandateStructure', 'workflowDependencies', 'mandateOffboarding', 'vdbPreparation'],
    },
    paths: ['/staff/mandate-expansion'],
  },
  mandateStructure: {
    requires: { all: ['mandateStructure'] },
    paths: ['/staff/mandate-expansion/structure'],
  },
  workflowDependencies: {
    requires: { all: ['workflowDependencies'] },
    paths: ['/staff/mandate-expansion/dependencies'],
  },
  mandateOffboarding: {
    requires: { all: ['mandateOffboarding'] },
    paths: ['/staff/mandate-expansion/offboarding'],
  },
  vdbPreparation: {
    requires: { all: ['vdbPreparation'] },
    paths: ['/staff/mandate-expansion/vdb'],
  },
  sanctionsScreening: {
    requires: { all: ['sanctionsScreening'] },
    paths: ['/staff/admin/screening', '/staff/clients/[id]/screening'],
  },
  feeCalculator: {
    requires: { all: ['feeCalculator'] },
    paths: ['/staff/stbvv', '/staff/clients/[id]/stbvv'],
  },
  bwa: {
    requires: { all: ['bwa'] },
    paths: ['/staff/reports', '/staff/clients/[id]/bwa', '/portal/bwa'],
  },
  timeTracking: { requires: { all: ['timeTracking'] }, paths: ['/staff/time'] },
  // Stundenabrechnung erzeugt In-App-Rechnungen: Zeiterfassung UND Rechnungsmodul.
  timeBilling: {
    requires: { all: ['timeTracking'], modes: ['invoices'] },
    paths: ['/staff/clients/[id]/billing'],
  },
  phoneNotes: { requires: { all: ['phoneNotes'] }, paths: ['/staff/phone-notes'] },
  // Der Kanzleikalender zeigt Steuertermine (taxNotices) UND Termine samt
  // Terminanfragen (appointments); er ist nutzbar, sobald eines davon aktiv ist,
  // und blendet die Inhalte des inaktiven Moduls aus.
  officeCalendar: {
    requires: { any: ['appointments', 'taxNotices'] },
    paths: ['/staff/calendar'],
  },
  taxNotices: {
    requires: { all: ['taxNotices'] },
    paths: [
      '/staff/tax-deadlines',
      '/staff/clients/[id]/notices',
      '/staff/clients/[id]/tax-schedule',
      '/portal/steuer',
    ],
  },
  workflows: {
    requires: { all: ['workflows'] },
    paths: ['/staff/workflows', '/staff/clients/[id]/workflows'],
  },
  forms: {
    requires: { all: ['forms'] },
    paths: ['/staff/forms', '/staff/clients/[id]/forms', '/portal/forms'],
  },
  reminders: { requires: { all: ['reminders'] }, paths: ['/staff/reminders'] },
  invoices: {
    requires: { modes: ['invoices'] },
    paths: ['/staff/invoices', '/staff/admin/invoice-categories', '/portal/invoices'],
  },
  poa: { requires: { modes: ['poa'] }, paths: ['/staff/poa'] },
  risk: {
    requires: { all: ['risk'] },
    paths: ['/staff/clients/[id]/subsumtion', '/staff/admin/quantenlos'],
  },
  appointments: { requires: { all: ['appointments'] }, paths: ['/portal/appointments'] },
  handovers: { requires: { all: ['handovers'] }, paths: ['/portal/handovers'] },
} as const satisfies Record<string, ModuleArea>;

export type ModuleAreaKey = keyof typeof MODULE_AREAS;

export const MODULE_AREA_KEYS = Object.keys(MODULE_AREAS) as ModuleAreaKey[];

function segments(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

/** Segmentweiser Präfix-Vergleich; `[x]` passt auf genau ein Segment. */
function pathMatches(template: string, pathname: string): boolean {
  const expected = segments(template);
  const actual = segments(pathname);
  if (actual.length < expected.length) return false;
  return expected.every(
    (segment, index) =>
      (segment.startsWith('[') && segment.endsWith(']')) || segment === actual[index],
  );
}

/** Spezifischster Registry-Bereich für einen Seitenpfad (oder null). */
export function moduleAreaForPath(surface: ModuleSurface, pathname: string): ModuleAreaKey | null {
  let best: { area: ModuleAreaKey; length: number } | null = null;
  for (const area of MODULE_AREA_KEYS) {
    for (const template of MODULE_AREAS[area].paths) {
      if (!template.startsWith(`/${surface}/`) || !pathMatches(template, pathname)) continue;
      const length = segments(template).length;
      if (!best || length > best.length) best = { area, length };
    }
  }
  return best?.area ?? null;
}

function modeEnabled(modules: ModuleConfig, mode: ModeModuleKey): boolean {
  return (mode === 'poa' ? modules.poaMode : modules.invoiceMode) !== 'OFF';
}

export function isModuleRequirementMet(
  modules: ModuleConfig,
  requirement: ModuleRequirement,
): boolean {
  if (requirement.all?.some((module) => !modules[module])) return false;
  if (requirement.any && !requirement.any.some((module) => modules[module])) return false;
  if (requirement.modes?.some((mode) => !modeEnabled(modules, mode))) return false;
  return true;
}

export function isModuleAreaEnabled(modules: ModuleConfig, area: ModuleAreaKey): boolean {
  return isModuleRequirementMet(modules, MODULE_AREAS[area].requires);
}
