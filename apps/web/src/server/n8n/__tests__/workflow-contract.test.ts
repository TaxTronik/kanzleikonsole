import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface WorkflowNode {
  id: string;
  name: string;
  type: string;
  parameters?: Record<string, unknown>;
  credentials?: Record<string, unknown>;
}

interface Workflow {
  name: string;
  active: boolean;
  nodes: WorkflowNode[];
  connections?: Record<
    string,
    { main?: Array<Array<{ node: string; type: string; index: number }>> }
  >;
  settings?: Record<string, unknown>;
}

const workflowDir = join(process.cwd(), '..', '..', 'infra', 'n8n', 'workflows');
const filenames = [
  '00-connection-test.json',
  '01-request-reminder.json',
  '02-gwg-expiry-check.json',
  '03-request-opened.json',
  '04-risk-research.json',
] as const;

function load(filename: (typeof filenames)[number]): { workflow: Workflow; raw: string } {
  const raw = readFileSync(join(workflowDir, filename), 'utf8');
  return { workflow: JSON.parse(raw) as Workflow, raw };
}

function node(workflow: Workflow, id: string): WorkflowNode {
  const found = workflow.nodes.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Node ${id} fehlt in ${workflow.name}`);
  return found;
}

function headers(candidate: WorkflowNode): Array<{ name?: string; value?: string }> {
  const container = candidate.parameters?.['headerParameters'] as
    | { parameters?: Array<{ name?: string; value?: string }> }
    | undefined;
  return container?.parameters ?? [];
}

function headerNames(candidate: WorkflowNode): string[] {
  return headers(candidate).map((header) => header.name ?? '');
}

function headerValue(candidate: WorkflowNode, name: string): string | undefined {
  return headers(candidate).find((header) => header.name === name)?.value;
}

describe('ausgelieferte n8n-Workflow-Vertraege', () => {
  it('liefert nur inaktive, datensparsame Vorlagen ohne eingebettete Credentials oder Env-Secrets', () => {
    for (const filename of filenames) {
      const { workflow, raw } = load(filename);
      expect(workflow.active, filename).toBe(false);
      expect(workflow.settings?.['saveDataSuccessExecution'], filename).toBe('none');
      expect(workflow.settings?.['saveDataErrorExecution'], filename).toBe('none');
      expect(workflow.settings?.['saveExecutionProgress'], filename).toBe(false);
      expect(raw, filename).not.toContain('$env');
      expect(raw, filename).not.toContain('$vars');
      expect(raw, filename).not.toContain('N8N_HMAC_SECRET');
      expect(raw, filename).not.toContain('import crypto');
      expect(
        workflow.nodes.every((candidate) => candidate.credentials === undefined),
        filename,
      ).toBe(true);
    }
  });

  it('verwendet nur die fest vereinbarten nicht geheimen Import-Tokens', () => {
    const expectedByFile: Record<(typeof filenames)[number], string[]> = {
      '00-connection-test.json': [],
      '01-request-reminder.json': [
        '__SMTP_FROM__',
        '__TAXTRONIK_API_URL__',
        '__TAXTRONIK_CALLBACK_KEY_ID__',
      ],
      '02-gwg-expiry-check.json': [
        '__GWG_OFFICER_EMAIL__',
        '__SMTP_FROM__',
        '__TAXTRONIK_API_URL__',
        '__TAXTRONIK_CALLBACK_KEY_ID__',
      ],
      '03-request-opened.json': [],
      '04-risk-research.json': ['__TAXTRONIK_API_URL__', '__TAXTRONIK_CALLBACK_KEY_ID__'],
    };

    for (const filename of filenames) {
      const { raw } = load(filename);
      const actual = [...new Set(raw.match(/__[A-Z0-9_]+__/g) ?? [])].sort();
      expect(actual, filename).toEqual(expectedByFile[filename].sort());
    }
  });

  it.each([
    ['00-connection-test.json', 'taxtronik.ping'],
    ['03-request-opened.json', 'request.opened'],
    ['04-risk-research.json', 'risk.research_requested'],
  ] as const)(
    '%s verifiziert den Outbound-Envelope mit Crypto-Credential und stabiler Delivery-ID',
    (file, event) => {
      const { workflow } = load(file);
      const crypto = node(workflow, 'calculate-hmac');
      const validate = node(workflow, 'validate-envelope');
      const validationCode = String(validate.parameters?.['jsCode'] ?? '');

      expect(crypto.type).toBe('n8n-nodes-base.crypto');
      expect(crypto.parameters).toMatchObject({
        action: 'hmac',
        type: 'SHA256',
        encoding: 'hex',
        dataPropertyName: 'expectedSignature',
      });
      expect(String(crypto.parameters?.['value'])).toContain("join('\\n')");
      expect(validationCode).toContain(`event !== '${event}'`);
      expect(validationCode).toContain("headers['x-taxtronik-timestamp']");
      expect(validationCode).toContain("headers['x-taxtronik-signature']");
      expect(validationCode).toContain("headers['x-taxtronik-nonce']");
      expect(validationCode).toContain("headers['x-taxtronik-delivery-id']");
      expect(validationCode).toContain('body.deliveryId');
      expect(validationCode).toContain('300000');
      expect(
        workflow.nodes.some((candidate) => candidate.type === 'n8n-nodes-base.removeDuplicates'),
      ).toBe(false);
    },
  );

  it('00 antwortet nach erfolgreicher Pruefung mit einer synthetischen Challenge', () => {
    const { workflow } = load('00-connection-test.json');
    const response = node(workflow, 'respond');
    expect(response.type).toBe('n8n-nodes-base.respondToWebhook');
    expect(String(response.parameters?.['responseBody'])).toContain('taxtronik-connection-ok');
  });

  it.each([
    ['01-request-reminder.json', 'fetch-overdue', '/api/integrations/n8n/v1/overdue-requests'],
    ['02-gwg-expiry-check.json', 'fetch-expiring', '/api/integrations/n8n/v1/expiring-gwg-checks'],
  ] as const)('%s nutzt den tenantgebundenen v1-Callback-Vertrag', (file, nodeId, path) => {
    const { workflow } = load(file);
    const request = node(workflow, nodeId);
    const url = String(request.parameters?.['url'] ?? '');

    expect(url).toBe(`__TAXTRONIK_API_URL__${path}`);
    expect(url).not.toContain('tenantId');
    expect(request.parameters).toMatchObject({
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
    });
    expect(headerNames(request)).toEqual(
      expect.arrayContaining(['x-taxtronik-key-id', 'x-taxtronik-request-id']),
    );
    expect(headerValue(request, 'x-taxtronik-key-id')).toBe('__TAXTRONIK_CALLBACK_KEY_ID__');
  });

  it('materialisiert Mailadressen nur ueber die sichtbaren Import-Tokens', () => {
    const reminder = node(load('01-request-reminder.json').workflow, 'send-reminder-mail');
    const gwg = node(load('02-gwg-expiry-check.json').workflow, 'send-warning-mail');
    expect(reminder.parameters?.['fromEmail']).toBe('__SMTP_FROM__');
    expect(reminder.parameters?.['toEmail']).toBe('={{ $json.signerEmail }}');
    expect(reminder.parameters?.['toEmail']).not.toContain('contactEmail');
    expect(gwg.parameters?.['fromEmail']).toBe('__SMTP_FROM__');
    expect(gwg.parameters?.['toEmail']).toBe('__GWG_OFFICER_EMAIL__');
  });

  it('01 enthaelt keinen internen Portal-Link', () => {
    const { raw } = load('01-request-reminder.json');
    expect(raw).not.toContain('/portal/');
  });

  it('03 bestaetigt das Event ohne eine zweite Mandanten-Mail', () => {
    const { workflow } = load('03-request-opened.json');
    expect(workflow.nodes.some((candidate) => candidate.type === 'n8n-nodes-base.emailSend')).toBe(
      false,
    );
    expect(node(workflow, 'respond').type).toBe('n8n-nodes-base.respondToWebhook');
  });

  it('04 ist eine gestoppte Vorlage und ruft Ergebnisse ueber research:write v1 zurueck', () => {
    const { workflow } = load('04-risk-research.json');
    expect(workflow.name).toContain('VORLAGE');
    expect(workflow.nodes.some((candidate) => candidate.type === 'n8n-nodes-base.stickyNote')).toBe(
      true,
    );
    expect(String(node(workflow, 'research-template').parameters?.['jsCode'])).toContain(
      'VORLAGE INAKTIV',
    );

    const callback = node(workflow, 'post-result');
    const url = String(callback.parameters?.['url'] ?? '');
    expect(url).toBe('__TAXTRONIK_API_URL__/api/integrations/n8n/v1/research-result');
    expect(url).not.toContain('tenantId');
    expect(callback.parameters).toMatchObject({
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
    });
    expect(headerNames(callback)).toEqual(
      expect.arrayContaining(['x-taxtronik-key-id', 'x-taxtronik-request-id']),
    );
    expect(headerValue(callback, 'x-taxtronik-key-id')).toBe('__TAXTRONIK_CALLBACK_KEY_ID__');
    expect(headerValue(callback, 'x-taxtronik-request-id')).toContain('body.deliveryId');
    expect(headerValue(callback, 'x-taxtronik-request-id')).not.toContain('$execution.id');

    expect(workflow.connections?.['Event und Signatur validieren']?.main).toEqual([
      [{ node: 'STOPP: Recherche freigeben', type: 'main', index: 0 }],
    ]);
    expect(workflow.connections?.['STOPP: Recherche freigeben']?.main).toEqual([
      [{ node: 'Event bestätigen', type: 'main', index: 0 }],
    ]);
    expect(workflow.connections?.['Event bestätigen']?.main).toEqual([
      [{ node: 'KI-Recherche (Beispiel)', type: 'main', index: 0 }],
    ]);
    expect(workflow.connections?.['Ergebnis tenantgebunden an TaxTronik']).toBeUndefined();
  });
});
