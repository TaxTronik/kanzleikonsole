// n8n-Admin-Actions: Routen speichern den angeforderten Aktivierungszustand,
// der Vorlagen-Import bricht an optionalen Werten nicht ab (statt
// Quelltextprüfung von n8n-actions.ts).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const tx = {
    n8nConnection: { findUnique: vi.fn(), update: vi.fn() },
    n8nWebhookEndpoint: { findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    n8nEventSubscription: { deleteMany: vi.fn(), createMany: vi.fn() },
  };
  return {
    tx,
    staffActionGuard: vi.fn(),
    evidenceRecord: vi.fn(),
    readN8nConfig: vi.fn(),
    prepareCallback: vi.fn(),
    listWorkflows: vi.fn(),
    createWorkflow: vi.fn(),
    materialize: vi.fn(),
    bindCredential: vi.fn(),
  };
});

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@taxtronik/config', () => ({
  env: { N8N_HMAC_SECRET: '', N8N_WEBHOOK_BASE_URL: '', SMTP_FROM: '' },
  n8nDeliveryMode: 'production',
}));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: (_ctx: unknown, fn: (tx: typeof h.tx) => unknown) => fn(h.tx),
}));
vi.mock('@taxtronik/db/tenant-settings', () => ({ deleteTenantSettingValue: vi.fn() }));
vi.mock('@/server/actions/staff-action', () => ({ staffActionGuard: h.staffActionGuard }));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.evidenceRecord } }));
vi.mock('@/server/http/ssrf-guard', () => ({ assertN8nUrl: vi.fn(), safeFetchN8n: vi.fn() }));
vi.mock('@/server/n8n/bundled-workflows', () => ({
  BUNDLED_N8N_WORKFLOWS: [
    {
      templateId: 'taxtronik.gwg-expiry-check',
      version: 1,
      name: 'GwG-Ablauf',
      description: 'Erinnert an ablaufende GwG-Prüfungen.',
      events: ['gwg.expired'],
      callbackScopes: ['gwg:read'],
      credentials: [],
      prerequisites: [],
      workflow: { name: 'TaxTronik GwG-Ablauf' },
    },
  ],
  bindN8nHeaderCredential: h.bindCredential,
  DEFAULT_GWG_OFFICER_EMAIL: 'gwg-beauftragte@example.invalid',
  materializeBundledN8nWorkflow: h.materialize,
  unresolvedBundledN8nPlaceholders: () => [],
}));
vi.mock('@/server/n8n/client', () => ({
  N8nApiClient: vi.fn(function N8nApiClient() {
    return { listWorkflows: h.listWorkflows, createWorkflow: h.createWorkflow };
  }),
}));
vi.mock('@/server/n8n/callback-import-setup', () => ({
  prepareN8nCallbackImport: h.prepareCallback,
}));
vi.mock('@/server/n8n/queue', () => ({ getN8nDeliverQueue: vi.fn() }));
vi.mock('@/server/settings/n8n', () => ({
  defaultN8nCallbackBase: () => 'http://app:3000',
  N8N_CALLBACK_SCOPES: [],
  readN8nConfig: h.readN8nConfig,
  resolveN8nConfig: vi.fn(),
  writeN8nConfigTx: vi.fn(),
}));
vi.mock('@/server/settings/smtp', () => ({
  readSmtpConfig: vi.fn(async () => ({ from: 'kanzlei@example.test' })),
}));
vi.mock('@/server/n8n/callback-credentials', () => ({ rotateN8nCallbackCredential: vi.fn() }));

import { importWorkflowsAction, saveN8nEndpointAction } from '../n8n-actions';

const TENANT = '00000000-0000-4000-8000-000000000001';
const CONFIG = {
  connectionId: 'connection-1',
  kind: 'SELF_HOSTED',
  apiBaseUrl: 'https://n8n.example.com/api/v1',
  apiKey: 'api-key',
  callbackBaseUrl: 'https://app.example.com',
  callbackKeyId: 'key-1',
  callbackConfigured: false,
  callbackScopes: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.staffActionGuard.mockResolvedValue({ ok: true, tenantId: TENANT, staffId: 'staff-1' });
  h.readN8nConfig.mockResolvedValue({ ...CONFIG });
  h.listWorkflows.mockResolvedValue([]);
  h.createWorkflow.mockResolvedValue({ id: 'wf-1' });
  h.materialize.mockImplementation((workflow: object, values: object) => ({ ...workflow, values }));
  h.bindCredential.mockImplementation((workflow: object, binding: unknown) => ({
    ...workflow,
    binding,
  }));
});

describe('importWorkflowsAction — geführter Import', () => {
  it('importiert die Vorlage trotz gescheiterter Rückkanal-Vorbereitung mit Hinweis', async () => {
    h.prepareCallback.mockRejectedValue(new Error('n8n nicht erreichbar'));

    const result = await importWorkflowsAction({
      templateIds: ['taxtronik.gwg-expiry-check'],
      gwgOfficerEmail: 'gwg@kanzlei.example',
    });

    expect(result.ok).toBe(true);
    expect(h.createWorkflow).toHaveBeenCalledTimes(1);
    expect(result.message).toContain('1 importiert');
    expect(result.message).toContain('Der Rückkanal konnte nicht automatisch vorbereitet werden.');
  });

  it('setzt ohne GwG-Empfänger den Platzhalter ein und weist darauf hin', async () => {
    h.prepareCallback.mockResolvedValue({ binding: null, configured: false });

    const result = await importWorkflowsAction({ templateIds: ['taxtronik.gwg-expiry-check'] });

    expect(result.ok).toBe(true);
    expect(h.materialize).toHaveBeenCalledWith(
      { name: 'TaxTronik GwG-Ablauf' },
      expect.objectContaining({
        gwgOfficerEmail: 'gwg-beauftragte@example.invalid',
        smtpFrom: 'kanzlei@example.test',
        callbackKeyId: 'key-1',
      }),
    );
    expect(result.message).toContain(
      'Die GwG-Vorlage enthält vorerst gwg-beauftragte@example.invalid.',
    );
  });

  it('bindet ein vorbereitetes Header-Credential an den importierten Workflow', async () => {
    const credential = {
      keyId: 'key-1',
      token: 'token',
      baseUrl: 'https://app.example.com',
      scopes: ['gwg:read'],
    };
    h.prepareCallback.mockResolvedValue({
      binding: { id: 'cred-1', name: 'TaxTronik Rückkanal' },
      configured: true,
      credential,
    });

    const result = await importWorkflowsAction({
      templateIds: ['taxtronik.gwg-expiry-check'],
      gwgOfficerEmail: 'gwg@kanzlei.example',
    });

    expect(h.prepareCallback).toHaveBeenCalledWith(
      { tenantId: TENANT, actorId: 'staff-1', actorType: 'STAFF' },
      expect.objectContaining({ connectionId: 'connection-1' }),
      expect.anything(),
      ['gwg:read'],
    );
    expect(h.createWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ binding: { id: 'cred-1', name: 'TaxTronik Rückkanal' } }),
    );
    expect(result).toMatchObject({ ok: true, callbackConfigured: true, credential });
  });
});

describe('saveN8nEndpointAction — Aktivierung', () => {
  function endpointForm(enabled: boolean): FormData {
    const form = new FormData();
    form.set('name', 'Mandant angelegt');
    form.set('productionUrl', 'https://n8n.example.com/webhook/client-created');
    // Fach-Events verlangen eine getrennte Test-URL (nur taxtronik.ping nicht).
    form.set('testUrl', 'https://n8n.example.com/webhook-test/client-created');
    form.append('events', 'client.created');
    if (enabled) form.set('enabled', 'on');
    return form;
  }

  beforeEach(() => {
    h.tx.n8nConnection.findUnique.mockResolvedValue({
      id: 'connection-1',
      enabled: false,
      routingMode: 'DISABLED',
    });
    h.tx.n8nWebhookEndpoint.create.mockResolvedValue({ id: 'endpoint-1' });
  });

  it('speichert eine aktivierte Route aktiv und gibt die Integration explizit frei', async () => {
    const result = await saveN8nEndpointAction(null, endpointForm(true));

    expect(result).toEqual({
      ok: true,
      connectionActivated: true,
      message: 'Workflow-Route gespeichert; n8n ist jetzt für explizite Routen aktiviert.',
    });
    expect(h.tx.n8nWebhookEndpoint.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ enabled: true }) }),
    );
    expect(h.tx.n8nConnection.update).toHaveBeenCalledWith({
      where: { id: 'connection-1' },
      data: { enabled: true, routingMode: 'EXPLICIT' },
    });
  });

  it('speichert eine nicht aktivierte Route inaktiv, ohne die Integration freizugeben', async () => {
    const result = await saveN8nEndpointAction(null, endpointForm(false));

    expect(result).toEqual({
      ok: true,
      connectionActivated: false,
      message: 'Workflow-Route gespeichert.',
    });
    expect(h.tx.n8nWebhookEndpoint.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ enabled: false }) }),
    );
    expect(h.tx.n8nConnection.update).toHaveBeenCalledWith({
      where: { id: 'connection-1' },
      data: {},
    });
  });
});
