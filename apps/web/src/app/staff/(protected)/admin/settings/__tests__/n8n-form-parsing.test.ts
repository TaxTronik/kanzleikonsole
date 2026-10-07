// Review-Befund R-12/K-02: Die n8n-Formulare (Verbindung, API-Test, Route)
// lesen über parseFormData und laufen über staffAction. Differenztest wie in
// form-data.test.ts: die bisherigen formData.get-Ketten (unten wörtlich) gegen
// die Action über dieselben FormData-Varianten — gleiche Daten an den Service,
// gleiche Gesamtmeldung; Ablehnungen tragen zusätzlich die Feldzuordnung.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionSchema, EndpointSchema } from '@/server/n8n-settings/validation';
import { UNEXPECTED_ACTION_ERROR } from '@/server/actions/to-action-error';
import { germanFieldError } from '@/server/actions/form-data';

const h = vi.hoisted(() => ({
  staffActionGuard: vi.fn(),
  saveN8nConnection: vi.fn(),
  testN8nApi: vi.fn(),
  saveN8nEndpoint: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/server/logger', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/server/n8n-settings/api-test', () => ({ testN8nApi: h.testN8nApi }));
vi.mock('@/server/n8n-settings/connection', () => ({
  generateN8nSigningSecret: vi.fn(),
  resetN8nConnection: vi.fn(),
  rotateN8nCallbackAccess: vi.fn(),
  saveN8nConnection: h.saveN8nConnection,
}));
vi.mock('@/server/n8n-settings/deliveries', () => ({
  acknowledgeN8nDelivery: vi.fn(),
  listFailedN8nDeliveries: vi.fn(),
  replayUnroutedN8nEvent: vi.fn(),
  retryN8nDelivery: vi.fn(),
  skipUnroutedN8nEvent: vi.fn(),
}));
vi.mock('@/server/n8n-settings/endpoints', () => ({
  deleteN8nEndpoint: vi.fn(),
  discoverN8nWebhooks: vi.fn(),
  saveN8nEndpoint: h.saveN8nEndpoint,
  testN8nEndpoint: vi.fn(),
}));
vi.mock('@/server/n8n-settings/workflows', () => ({
  importN8nWorkflows: vi.fn(),
  listN8nWorkflows: vi.fn(),
}));
vi.mock('@/server/n8n/bundled-workflows', () => ({ BUNDLED_N8N_WORKFLOWS: [] }));
vi.mock('@/server/actions/staff-action', async () => ({
  staffActionGuard: h.staffActionGuard,
  // K-02: echter mehrphasiger Ablauf über dem Gate-Mock.
  staffAction: (
    await vi.importActual<typeof import('@/server/actions/action-runner')>(
      '@/server/actions/action-runner',
    )
  ).createActionRunner(h.staffActionGuard),
}));

import { saveN8nAction, saveN8nEndpointAction, testN8nApiAction } from '../n8n-actions';

const TENANT = 'tenant-1';
const CONTEXT = { tenantId: TENANT, actorId: 'staff-1', actorType: 'STAFF' };

/**
 * Bisherige Zuordnung von n8n-actions.ts (parseConnectionForm) — mit der
 * deutschen Fehlerkarte von parseFormData (C7), damit Meldungen vergleichbar bleiben.
 */
const legacyConnection = (formData: FormData) =>
  ConnectionSchema.safeParse(
    {
      name: formData.get('name') ?? 'TaxTronik n8n',
      kind: formData.get('kind') ?? 'SELF_HOSTED',
      routingMode: formData.get('routingMode') ?? 'EXPLICIT',
      enabled: formData.get('enabled') === 'on',
      uiBaseUrl: formData.get('uiBaseUrl') ?? '',
      callbackBaseUrl: formData.get('callbackBaseUrl') ?? '',
      webhookBaseUrl: formData.get('webhookBaseUrl') ?? '',
      hmacSecret: formData.get('hmacSecret') ?? '',
      apiBaseUrl: formData.get('apiBaseUrl') ?? '',
      apiKey: formData.get('apiKey') ?? '',
      keepHmac: formData.get('keepHmac') === 'on',
      keepApiKey: formData.get('keepApiKey') === 'on',
    },
    { error: germanFieldError },
  );

/** Bisherige Zuordnung von n8n-actions.ts (parseEndpointForm). */
const legacyEndpoint = (formData: FormData) =>
  EndpointSchema.safeParse(
    {
      id: formData.get('id') ?? '',
      name: formData.get('name') ?? '',
      productionUrl: formData.get('productionUrl') ?? '',
      testUrl: formData.get('testUrl') ?? '',
      workflowId: formData.get('workflowId') ?? '',
      workflowName: formData.get('workflowName') ?? '',
      workflowNodeId: formData.get('workflowNodeId') ?? '',
      source: formData.get('source') ?? 'CUSTOM',
      enabled: formData.get('enabled') === 'on',
      testMode: formData.get('testMode') === 'on',
      events: formData.getAll('events'),
    },
    { error: germanFieldError },
  );

const file = () => new File(['x'], 'x.txt', { type: 'text/plain' });
type Entries = Array<[string, string | File]>;

const connectionVariants: Array<[string, Entries]> = [
  [
    'vollständig',
    [
      ['name', ' Kanzlei-n8n '],
      ['kind', 'CLOUD'],
      ['routingMode', 'LEGACY'],
      ['enabled', 'on'],
      ['uiBaseUrl', 'https://n8n.example'],
      ['callbackBaseUrl', 'https://app.example'],
      ['webhookBaseUrl', 'https://n8n.example'],
      ['hmacSecret', 'geheim'],
      ['apiBaseUrl', 'https://n8n.example/api/v1'],
      ['apiKey', 'key'],
      ['keepHmac', 'on'],
      ['keepApiKey', 'on'],
    ],
  ],
  ['alles fehlt', []],
  [
    'leere Felder',
    [
      ['name', ''],
      ['kind', ''],
      ['uiBaseUrl', ''],
      ['enabled', ''],
    ],
  ],
  [
    'Schalter mit anderem Wert, doppeltes Skalarfeld',
    [
      ['name', 'erster'],
      ['name', ''],
      ['enabled', 'yes'],
      ['keepHmac', 'true'],
      ['kind', 'BUNDLED'],
      ['kind', 'X'],
    ],
  ],
  [
    'ungültige Werte',
    [
      ['kind', 'X'],
      ['routingMode', 'Y'],
      ['hmacSecret', 'x'.repeat(1_001)],
    ],
  ],
  [
    'Datei statt Text',
    [
      ['name', file()],
      ['enabled', file()],
      ['apiKey', file()],
    ],
  ],
];

const endpointVariants: Array<[string, Entries]> = [
  [
    'vollständig',
    [
      ['id', '11111111-1111-4111-8111-111111111111'],
      ['name', 'Mandant angelegt'],
      ['productionUrl', 'https://n8n.example/webhook/client'],
      ['testUrl', 'https://n8n.example/webhook-test/client'],
      ['workflowId', 'wf-1'],
      ['workflowName', 'Mandant'],
      ['workflowNodeId', 'node-1'],
      ['source', 'MANAGED'],
      ['enabled', 'on'],
      ['testMode', 'on'],
      ['events', 'client.created'],
      ['events', 'taxtronik.ping'],
    ],
  ],
  ['alles fehlt', []],
  [
    'nur Pflichtangaben',
    [
      ['name', 'Ping'],
      ['productionUrl', 'https://n8n.example/webhook/ping'],
      ['events', 'taxtronik.ping'],
    ],
  ],
  [
    'Fach-Event ohne Test-URL, Test-Modus, unbekanntes Event',
    [
      ['name', 'Route'],
      ['productionUrl', 'https://n8n.example/webhook/route'],
      ['testMode', 'on'],
      ['events', 'client.created'],
      ['events', 'unbekannt'],
    ],
  ],
  [
    'Test-URL als Produktions-URL, Datei als Event',
    [
      ['name', 'Route'],
      ['productionUrl', 'https://n8n.example/webhook-test/route'],
      ['source', 'X'],
      ['events', file()],
    ],
  ],
];

function form(entries: Entries): FormData {
  const data = new FormData();
  for (const [name, value] of entries) data.append(name, value);
  return data;
}

/** Feldzuordnung eines abgelehnten Ergebnisses. */
function fieldNames(result: unknown): string[] {
  return Object.keys((result as { fieldErrors?: object }).fieldErrors ?? {});
}

function issueFields(issues: readonly { path: readonly PropertyKey[] }[]): string[] {
  return [...new Set(issues.map((issue) => issue.path.join('.') || '_form'))];
}

beforeEach(() => {
  vi.clearAllMocks();
  h.staffActionGuard.mockResolvedValue({
    ok: true,
    tenantId: TENANT,
    staffId: 'staff-1',
    session: { user: {} },
    ctx: CONTEXT,
  });
  h.saveN8nConnection.mockResolvedValue({ ok: true, message: 'gespeichert' });
  h.testN8nApi.mockResolvedValue({ ok: true, message: 'erreichbar' });
  h.saveN8nEndpoint.mockResolvedValue({ ok: true, message: 'Route gespeichert' });
});

describe('n8n-Verbindungsformular (saveN8nAction, testN8nApiAction)', () => {
  it.each(connectionVariants)(
    'liefert dieselben Daten bzw. Meldungen wie bisher (%s)',
    async (_, entries) => {
      const before = legacyConnection(form(entries));
      const saved = await saveN8nAction(null, form(entries));
      const tested = await testN8nApiAction(null, form(entries));

      expect(h.staffActionGuard).toHaveBeenCalledWith({ requireAdmin: true });
      if (before.success) {
        expect(saved).toEqual({ ok: true, message: 'gespeichert' });
        expect(tested).toEqual({ ok: true, message: 'erreichbar' });
        expect(h.saveN8nConnection).toHaveBeenCalledWith(CONTEXT, before.data);
        expect(h.testN8nApi).toHaveBeenCalledWith(CONTEXT, before.data);
        return;
      }
      const fields = issueFields(before.error.issues);
      expect(saved).toMatchObject({
        ok: false,
        error: before.error.issues[0]?.message ?? 'Ungültige Eingabe.',
        errorCode: 'VALIDATION_ERROR',
      });
      expect(fieldNames(saved)).toEqual(fields);
      expect(tested).toMatchObject({ ok: false, error: 'Ungültige Eingabe.' });
      expect(h.saveN8nConnection).not.toHaveBeenCalled();
      expect(h.testN8nApi).not.toHaveBeenCalled();
    },
  );

  it('meldet eine URL ohne Schema als Feldfehler statt einer Fehlerseite', async () => {
    // Das Service-Schema (HttpUrl) rief `new URL` auch nach gescheiterter
    // URL-Prüfung auf und warf dabei einen TypeError (früher eine Fehlerseite,
    // nach K-02 die zentrale Meldung); jetzt ist es ein Feldfehler.
    const entries: Entries = [['uiBaseUrl', 'n8n.example']];
    const before = legacyConnection(form(entries));
    expect(before.success).toBe(false);

    const saved = await saveN8nAction(null, form(entries));
    expect(saved).toMatchObject({ ok: false, errorCode: 'VALIDATION_ERROR' });
    expect(fieldNames(saved)).toContain('uiBaseUrl');
    expect(h.saveN8nConnection).not.toHaveBeenCalled();
  });
});

describe('n8n-Routenformular (saveN8nEndpointAction)', () => {
  it.each(endpointVariants)(
    'liefert dieselben Daten bzw. Meldungen wie bisher (%s)',
    async (_, entries) => {
      let before: ReturnType<typeof legacyEndpoint> | null = null;
      try {
        before = legacyEndpoint(form(entries));
      } catch {
        // Vor der Korrektur von HttpUrl warf eine leere oder schemalose
        // Produktions-URL hier; der Zweig bleibt als Absicherung.
      }
      const result = await saveN8nEndpointAction(null, form(entries));

      if (!before) {
        expect(result).toEqual({ ok: false, error: UNEXPECTED_ACTION_ERROR });
      } else if (before.success) {
        expect(result).toEqual({ ok: true, message: 'Route gespeichert' });
        expect(h.saveN8nEndpoint).toHaveBeenCalledWith(CONTEXT, before.data);
        return;
      } else {
        expect(result).toMatchObject({
          ok: false,
          error: before.error.issues[0]?.message ?? 'Ungültige Route.',
          errorCode: 'VALIDATION_ERROR',
        });
        expect(fieldNames(result)).toEqual(issueFields(before.error.issues));
      }
      expect(h.saveN8nEndpoint).not.toHaveBeenCalled();
    },
  );

  it('gibt die Ablehnung des Gates unverändert zurück', async () => {
    h.staffActionGuard.mockResolvedValue({ ok: false, error: 'Nur ADMIN/PARTNER.' });

    expect(await saveN8nEndpointAction(null, form(endpointVariants[0]![1]))).toEqual({
      ok: false,
      error: 'Nur ADMIN/PARTNER.',
    });
    expect(h.saveN8nEndpoint).not.toHaveBeenCalled();
  });
});
