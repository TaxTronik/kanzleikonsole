import {
  isModeModuleEnabled,
  type BooleanModuleKey,
  type ModeModuleKey,
  type ModuleConfig,
} from './modules';

interface ModuleRouteRequirement {
  /** Alle genannten Module müssen aktiv sein. */
  all?: BooleanModuleKey[];
  /** Mindestens eines der genannten Module muss aktiv sein. */
  any?: BooleanModuleKey[];
  /** Spezialmodule, deren Betriebsmodus nicht OFF sein darf. */
  modes?: ModeModuleKey[];
}

interface RouteRule extends ModuleRouteRequirement {
  pattern: RegExp;
}

const STAFF_RULES: RouteRule[] = [
  { pattern: /^\/staff\/interactions(?:\/|$)/, any: ['noticeDecisions', 'feedbackSurveys'] },
  { pattern: /^\/staff\/knowledge\/context(?:\/|$)/, all: ['knowledge', 'knowledgeContext'] },
  { pattern: /^\/staff\/mailbox(?:\/|$)/, all: ['smartMailbox'] },
  { pattern: /^\/staff\/payroll(?:\/|$)/, all: ['payrollIntake'] },
  {
    pattern: /^\/staff\/client-assistance(?:\/|$)/,
    any: ['expenseAssistance', 'clientProcedures'],
  },
  { pattern: /^\/staff\/year-end(?:\/|$)/, all: ['yearEndCampaigns'] },
  { pattern: /^\/staff\/feedback(?:\/|$)/, all: ['feedbackSurveys'] },
  {
    pattern: /^\/staff\/mandate-expansion(?:\/|$)/,
    any: ['mandateStructure', 'workflowDependencies', 'mandateOffboarding', 'vdbPreparation'],
  },
  {
    pattern: /^\/staff\/(?:clients\/[^/]+\/|admin\/)?screening(?:\/|$)/,
    all: ['sanctionsScreening'],
  },
  { pattern: /^\/staff\/(?:clients\/[^/]+\/)?stbvv(?:\/|$)/, all: ['feeCalculator'] },
  { pattern: /^\/staff\/clients\/[^/]+\/bwa(?:\/|$)/, all: ['bwa'] },
  { pattern: /^\/staff\/reports(?:\/|$)/, all: ['bwa'] },
  { pattern: /^\/staff\/knowledge(?:\/|$)/, all: ['knowledge'] },
  { pattern: /^\/staff\/time(?:\/|$)/, all: ['timeTracking'] },
  {
    pattern: /^\/staff\/clients\/[^/]+\/billing(?:\/|$)/,
    all: ['timeTracking'],
    modes: ['invoices'],
  },
  { pattern: /^\/staff\/phone-notes(?:\/|$)/, all: ['phoneNotes'] },
  { pattern: /^\/staff\/tax-deadlines(?:\/|$)/, all: ['taxNotices'] },
  { pattern: /^\/staff\/clients\/[^/]+\/(?:notices|tax-schedule)(?:\/|$)/, all: ['taxNotices'] },
  { pattern: /^\/staff\/workflows(?:\/|$)/, all: ['workflows'] },
  { pattern: /^\/staff\/clients\/[^/]+\/workflows(?:\/|$)/, all: ['workflows'] },
  { pattern: /^\/staff\/forms(?:\/|$)/, all: ['forms'] },
  { pattern: /^\/staff\/clients\/[^/]+\/forms(?:\/|$)/, all: ['forms'] },
  { pattern: /^\/staff\/reminders(?:\/|$)/, all: ['reminders'] },
  { pattern: /^\/staff\/invoices(?:\/|$)/, modes: ['invoices'] },
  { pattern: /^\/staff\/admin\/invoice-categories(?:\/|$)/, modes: ['invoices'] },
  { pattern: /^\/staff\/poa(?:\/|$)/, modes: ['poa'] },
  { pattern: /^\/staff\/clients\/[^/]+\/subsumtion(?:\/|$)/, all: ['risk'] },
  { pattern: /^\/staff\/admin\/quantenlos(?:\/|$)/, all: ['risk'] },
  // Der gemeinsame Kanzleikalender bleibt nutzbar, solange wenigstens Termine
  // oder Steuerfristen aktiv sind. Die jeweiligen Writes sind separat gegatet.
  { pattern: /^\/staff\/calendar(?:\/|$)/, any: ['appointments', 'taxNotices'] },
];

const PORTAL_RULES: RouteRule[] = [
  { pattern: /^\/portal\/interactions(?:\/|$)/, any: ['noticeDecisions', 'feedbackSurveys'] },
  { pattern: /^\/portal\/payroll(?:\/|$)/, all: ['payrollIntake'] },
  {
    pattern: /^\/portal\/client-assistance(?:\/|$)/,
    any: ['expenseAssistance', 'clientProcedures'],
  },
  { pattern: /^\/portal\/feedback(?:\/|$)/, all: ['feedbackSurveys'] },
  { pattern: /^\/portal\/bwa(?:\/|$)/, all: ['bwa'] },
  { pattern: /^\/portal\/forms(?:\/|$)/, all: ['forms'] },
  { pattern: /^\/portal\/appointments(?:\/|$)/, all: ['appointments'] },
  { pattern: /^\/portal\/handovers(?:\/|$)/, all: ['handovers'] },
  { pattern: /^\/portal\/steuer(?:\/|$)/, all: ['taxNotices'] },
  { pattern: /^\/portal\/invoices(?:\/|$)/, modes: ['invoices'] },
];

export function moduleRouteRequirement(
  surface: 'staff' | 'portal',
  pathname: string,
): ModuleRouteRequirement | null {
  const rule = (surface === 'staff' ? STAFF_RULES : PORTAL_RULES).find((candidate) =>
    candidate.pattern.test(pathname),
  );
  return rule ? { all: rule.all, any: rule.any, modes: rule.modes } : null;
}

/** Serverseitige Entscheidung für direkt adressierte Modul-Seiten. */
export function isModuleRouteEnabled(
  modules: ModuleConfig,
  surface: 'staff' | 'portal',
  pathname: string,
): boolean {
  const requirement = moduleRouteRequirement(surface, pathname);
  if (!requirement) return true;
  if (requirement.all?.some((module) => !modules[module])) return false;
  if (requirement.any && !requirement.any.some((module) => modules[module])) return false;
  if (requirement.modes?.some((module) => !isModeModuleEnabled(modules, module))) return false;
  return true;
}
