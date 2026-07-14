// Statische Imports sind beabsichtigt: Nexts Standalone-Image enthält keine
// frei gelesenen Repo-Dateien aus infra/. Durch resolveJsonModule werden die
// Vorlagen Teil des Server-Bundles und funktionieren auch im Docker-Release.
import connectionTest from '../../../../../infra/n8n/workflows/00-connection-test.json';
import requestReminder from '../../../../../infra/n8n/workflows/01-request-reminder.json';
import gwgExpiryCheck from '../../../../../infra/n8n/workflows/02-gwg-expiry-check.json';
import requestOpened from '../../../../../infra/n8n/workflows/03-request-opened.json';
import riskResearch from '../../../../../infra/n8n/workflows/04-risk-research.json';

export interface BundledN8nWorkflow {
  templateId: string;
  version: number;
  name: string;
  description: string;
  events: string[];
  callbackScopes: string[];
  prerequisites: string[];
  workflow: Record<string, unknown>;
}

export interface BundledN8nWorkflowValues {
  taxtronikApiUrl: string;
  callbackKeyId: string;
  smtpFrom: string;
  gwgOfficerEmail: string;
}

export const BUNDLED_N8N_PLACEHOLDERS = {
  taxtronikApiUrl: '__TAXTRONIK_API_URL__',
  callbackKeyId: '__TAXTRONIK_CALLBACK_KEY_ID__',
  smtpFrom: '__SMTP_FROM__',
  gwgOfficerEmail: '__GWG_OFFICER_EMAIL__',
} as const;

function workflow(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

export const BUNDLED_N8N_WORKFLOWS: readonly BundledN8nWorkflow[] = [
  {
    templateId: 'taxtronik.connection-test',
    version: 1,
    name: '00 — TaxTronik Verbindungstest',
    description: 'Nebenwirkungsfreier Webhook für Einrichtung und Zustelltest.',
    events: ['taxtronik.ping'],
    callbackScopes: [],
    prerequisites: [
      'TaxTronik HMAC-Credential in n8n zuordnen',
      'Workflow prüfen und veröffentlichen',
    ],
    workflow: workflow(connectionTest),
  },
  {
    templateId: 'taxtronik.request-reminder',
    version: 1,
    name: '01 — Request Reminder (täglich)',
    description: 'Ruft fällige Mandantenanfragen ab und stößt eine Erinnerung an.',
    events: [],
    callbackScopes: ['requests:read'],
    prerequisites: ['TaxTronik Callback-Credential zuordnen', 'Mail-Credential prüfen'],
    workflow: workflow(requestReminder),
  },
  {
    templateId: 'taxtronik.gwg-expiry-check',
    version: 1,
    name: '02 — GwG-Ablauf-Warnung (täglich)',
    description: 'Prüft tenantgebunden ablaufende GwG-Identifizierungen.',
    events: [],
    callbackScopes: ['gwg:read'],
    prerequisites: ['TaxTronik Callback-Credential zuordnen', 'Mail-Credential prüfen'],
    workflow: workflow(gwgExpiryCheck),
  },
  {
    templateId: 'taxtronik.request-opened',
    version: 1,
    name: '03 — Request Opened (Webhook von App)',
    description: 'Beispiel für einen signierten TaxTronik-Event-Webhook.',
    events: ['request.opened'],
    callbackScopes: [],
    prerequisites: [
      'TaxTronik HMAC-Credential in n8n zuordnen',
      'Workflow prüfen und veröffentlichen',
    ],
    workflow: workflow(requestOpened),
  },
  {
    templateId: 'taxtronik.risk-research',
    version: 1,
    name: '04 — Risk-Research (VORLAGE — nicht produktiv)',
    description: 'Bewusst inaktive Vorlage für eine individuell geprüfte Research-Anbindung.',
    events: ['risk.research_requested'],
    callbackScopes: ['research:write'],
    prerequisites: [
      'Research-Anbieter und Datenschutzprüfung ergänzen',
      'TaxTronik HMAC- und Callback-Credentials zuordnen',
      'Erst nach fachlicher Prüfung veröffentlichen',
    ],
    workflow: workflow(riskResearch),
  },
] as const;

export function bundledN8nWorkflowSummaries() {
  return BUNDLED_N8N_WORKFLOWS.map(({ workflow: _workflow, ...entry }) => entry);
}

function replaceWorkflowValues(
  value: unknown,
  replacements: Readonly<Record<string, string>>,
): unknown {
  if (typeof value === 'string') {
    let result = value;
    for (const [placeholder, replacement] of Object.entries(replacements)) {
      result = result.replaceAll(placeholder, replacement);
    }
    return result;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => replaceWorkflowValues(entry, replacements));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        replaceWorkflowValues(entry, replacements),
      ]),
    );
  }
  return value;
}

export function unresolvedBundledN8nPlaceholders(workflow: Record<string, unknown>): string[] {
  return [...new Set(JSON.stringify(workflow).match(/__[A-Z][A-Z0-9_]+__/g) ?? [])];
}

/** Materialisiert ausschließlich nicht-geheime Installationswerte. */
export function materializeBundledN8nWorkflow(
  workflowTemplate: Record<string, unknown>,
  values: BundledN8nWorkflowValues,
): Record<string, unknown> {
  return replaceWorkflowValues(workflowTemplate, {
    [BUNDLED_N8N_PLACEHOLDERS.taxtronikApiUrl]: values.taxtronikApiUrl,
    [BUNDLED_N8N_PLACEHOLDERS.callbackKeyId]: values.callbackKeyId,
    [BUNDLED_N8N_PLACEHOLDERS.smtpFrom]: values.smtpFrom,
    [BUNDLED_N8N_PLACEHOLDERS.gwgOfficerEmail]: values.gwgOfficerEmail,
  }) as Record<string, unknown>;
}
