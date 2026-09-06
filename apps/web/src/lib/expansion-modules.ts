import type { BooleanModuleKey } from '@/server/settings/modules';

/** Opt-in rollout: no new workflow, data feed or communication starts on upgrade. */
export const EXPANSION_MODULES = [
  {
    key: 'knowledgeContext',
    label: 'Wiki im Bearbeitungskontext',
    description: 'Interne Wissensartikel an Workflows und Anforderungen.',
    href: '/staff/knowledge/context',
  },
  {
    key: 'yearEndCampaigns',
    label: 'Jahreswechselkampagnen',
    description: 'Versionierte Checklisten gesammelt an Mandanten ausgeben.',
    href: '/staff/year-end',
  },
  {
    key: 'noticeDecisions',
    label: 'Bescheidentscheidungen',
    description: 'Dokumentierte Mandantenantworten zu konkreten Bescheidständen.',
    href: '/staff/interactions',
  },
  {
    key: 'smartMailbox',
    label: 'Smart-Mailbox',
    description: 'IMAP-Eingangskorb mit Virenprüfung und bestätigter Zuordnung.',
    href: '/staff/mailbox',
  },
  {
    key: 'payrollIntake',
    label: 'Personalfragebogen',
    description: 'Geschützte Lohnerfassung und DATEV-LuG-Übergabe.',
    href: '/staff/payroll',
  },
  {
    key: 'expenseAssistance',
    label: 'Bewirtung und Eigenbelege',
    description: 'Beleggebundene Ergänzungen mit versionierten Angaben.',
    href: '/staff/client-assistance',
  },
  {
    key: 'clientProcedures',
    label: 'Mandanten-Verfahrensdokumentation',
    description: 'Versionierte Prozessbeschreibung als Word und PDF.',
    href: '/staff/client-assistance',
  },
  {
    key: 'feedbackSurveys',
    label: 'Mandantenfeedback',
    description: 'Freiwillige Bewertungen ausgewählter Meilensteine.',
    href: '/staff/interactions',
  },
  {
    key: 'mandateStructure',
    label: 'Beteiligungsstruktur',
    description: 'Dokumentierte Beteiligungen ohne automatische rechtliche Einordnung.',
    href: '/staff/mandate-expansion',
  },
  {
    key: 'workflowDependencies',
    label: 'Workflow-Abhängigkeiten',
    description: 'Explizite Vorleistungen zwischen Mandantenvorgängen.',
    href: '/staff/mandate-expansion',
  },
  {
    key: 'mandateOffboarding',
    label: 'Mandats-Offboarding',
    description: 'Geprüfte Übergabe, Zugangssperre und Aufbewahrungsübersicht.',
    href: '/staff/mandate-expansion',
  },
  {
    key: 'vdbPreparation',
    label: 'VDB-Vorbereitung',
    description: 'Stammdatenvorbereitung und belegte externe Rückmeldungen.',
    href: '/staff/mandate-expansion',
  },
  {
    key: 'sanctionsScreening',
    label: 'Sanktions- und PEP-Prüfung',
    description: 'Lokaler EU-Abgleich und dokumentierte manuelle PEP-Recherche.',
    href: '/staff/admin/screening',
  },
  {
    key: 'feeCalculator',
    label: 'StBVV-Honorarvorschläge',
    description: 'Versionierter Gebührenkatalog mit nachvollziehbarer Berechnung.',
    href: '/staff/stbvv',
  },
] satisfies Array<{
  key: BooleanModuleKey;
  label: string;
  description: string;
  href: string | null;
}>;
