// Statische Imports sind beabsichtigt: Nexts Standalone-Image enthält keine
// frei gelesenen Repo-Dateien aus infra/. Durch resolveJsonModule werden die
// Vorlagen Teil des Server-Bundles und funktionieren auch im Docker-Release.
import connectionTest from '../../../../../infra/n8n/workflows/00-connection-test.json';
import requestReminder from '../../../../../infra/n8n/workflows/01-request-reminder.json';
import gwgExpiryCheck from '../../../../../infra/n8n/workflows/02-gwg-expiry-check.json';
import requestOpened from '../../../../../infra/n8n/workflows/03-request-opened.json';
import riskResearch from '../../../../../infra/n8n/workflows/04-risk-research.json';

/**
 * Strukturierte Credential-Anforderung einer Vorlage. Wird im ACP pro
 * Template-Karte angezeigt, damit klar ist, WELCHES der ähnlich benannten
 * Secrets (Outbound-HMAC ≠ Rückkanal-Token ≠ API-Key ≠ N8N_ENCRYPTION_KEY)
 * wohin gehört und woher der Wert kommt.
 */
export interface BundledN8nCredential {
  /** Sprechender Name inkl. Richtung, z. B. "Outbound-Signatur (TaxTronik → n8n)". */
  name: string;
  /** Credential-Typ, der in n8n anzulegen ist. */
  n8nType: string;
  /** Wo der Admin den Wert herbekommt. */
  source: string;
}

export interface BundledN8nWorkflow {
  templateId: string;
  version: number;
  name: string;
  description: string;
  events: string[];
  callbackScopes: string[];
  /** In n8n manuell anzulegende/zuzuordnende Credentials. */
  credentials: BundledN8nCredential[];
  /** Verbleibende manuelle Schritte nach dem Import. */
  prerequisites: string[];
  workflow: Record<string, unknown>;
}

const HMAC_CREDENTIAL: BundledN8nCredential = {
  name: 'Outbound-Signatur (TaxTronik → n8n)',
  n8nType: 'Crypto-Credential (HMAC-SHA256)',
  source:
    'ACP Abschnitt 1, Feld „Outbound-Signatur-Secret“ — beim Generieren/Eingeben direkt kopieren, wird danach nicht erneut angezeigt.',
};

const CALLBACK_CREDENTIAL: BundledN8nCredential = {
  name: 'Rückkanal-Token (n8n → TaxTronik)',
  n8nType: 'Header-Auth-Credential (Authorization: Bearer …)',
  source:
    'ACP Abschnitt 2 „Callback-Token erzeugen“ — einmalige Anzeige, Key-ID wird beim Import automatisch eingesetzt.',
};

const SMTP_CREDENTIAL: BundledN8nCredential = {
  name: 'Mailversand',
  n8nType: 'SMTP-Credential',
  source: 'Eigener Mailserver (kann identisch zu den TaxTronik-SMTP-Daten sein).',
};

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
    credentials: [HMAC_CREDENTIAL],
    prerequisites: ['Workflow prüfen und veröffentlichen'],
    workflow: workflow(connectionTest),
  },
  {
    templateId: 'taxtronik.request-reminder',
    version: 1,
    name: '01 — Request Reminder (täglich)',
    description: 'Ruft fällige Mandantenanfragen ab und stößt eine Erinnerung an.',
    events: [],
    callbackScopes: ['requests:read'],
    credentials: [CALLBACK_CREDENTIAL, SMTP_CREDENTIAL],
    prerequisites: ['Workflow prüfen und veröffentlichen'],
    workflow: workflow(requestReminder),
  },
  {
    templateId: 'taxtronik.gwg-expiry-check',
    version: 1,
    name: '02 — GwG-Ablauf-Warnung (täglich)',
    description: 'Prüft tenantgebunden ablaufende GwG-Identifizierungen.',
    events: [],
    callbackScopes: ['gwg:read'],
    credentials: [CALLBACK_CREDENTIAL, SMTP_CREDENTIAL],
    prerequisites: ['Workflow prüfen und veröffentlichen'],
    workflow: workflow(gwgExpiryCheck),
  },
  {
    templateId: 'taxtronik.request-opened',
    version: 1,
    name: '03 — Request Opened (Webhook von App)',
    description: 'Beispiel für einen signierten TaxTronik-Event-Webhook.',
    events: ['request.opened'],
    callbackScopes: [],
    credentials: [HMAC_CREDENTIAL],
    prerequisites: ['Workflow prüfen und veröffentlichen'],
    workflow: workflow(requestOpened),
  },
  {
    templateId: 'taxtronik.risk-research',
    version: 1,
    name: '04 — Risk-Research (VORLAGE — nicht produktiv)',
    description: 'Bewusst inaktive Vorlage für eine individuell geprüfte Research-Anbindung.',
    events: ['risk.research_requested'],
    callbackScopes: ['research:write'],
    credentials: [HMAC_CREDENTIAL, CALLBACK_CREDENTIAL],
    prerequisites: [
      'Research-Anbieter und Datenschutzprüfung ergänzen',
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
