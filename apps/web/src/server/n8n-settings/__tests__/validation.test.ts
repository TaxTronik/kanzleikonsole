// Review-Finding K-03: reine Prüf- und Normalisierungsregeln der
// n8n-Einstellungen (server/n8n-settings/validation.ts) ohne IO.
import { describe, expect, it } from 'vitest';
import { N8N_EVENT_CATALOG } from '@taxtronik/n8n-shared';
import type { N8nConfig } from '@/server/settings/n8n';
import {
  connectionChange,
  connectionSaveRejection,
  ConnectionSchema,
  effectiveConnectionSecrets,
  EndpointSchema,
  endpointRouteChange,
  joinWebhookUrl,
  n8nApiConfigurationError,
  normalizedConnectionConfig,
  pingChallengeOk,
  sameUrlOrigin,
  storedApiKeyLeavesInstance,
  syntheticN8nTestEvent,
  testWebhookPrefix,
  webhookTargetKind,
  webhookVerificationError,
  WorkflowImportSchema,
  type N8nConnectionInput,
} from '../validation';

const SECRET = 'x'.repeat(32);

function connection(patch: Partial<N8nConnectionInput> = {}): N8nConnectionInput {
  return {
    name: 'TaxTronik n8n',
    kind: 'SELF_HOSTED',
    routingMode: 'EXPLICIT',
    enabled: true,
    uiBaseUrl: '',
    callbackBaseUrl: '',
    webhookBaseUrl: '',
    hmacSecret: SECRET,
    apiBaseUrl: 'https://n8n.example.com/api/v1',
    apiKey: 'api-key',
    keepHmac: false,
    keepApiKey: false,
    ...patch,
  };
}

/** Gespeicherte Verbindung (ohne Laden von server/settings/n8n: kein ENV nötig). */
function stored(patch: Partial<N8nConfig> = {}): N8nConfig {
  return {
    connectionId: 'connection-1',
    name: 'TaxTronik n8n',
    kind: 'SELF_HOSTED',
    routingMode: 'EXPLICIT',
    enabled: true,
    uiBaseUrl: '',
    callbackBaseUrl: '',
    webhookBaseUrl: '',
    hmacSecret: 'stored-secret-with-at-least-32-characters',
    apiBaseUrl: 'https://n8n.example.com/api/v1',
    apiKey: 'stored-api-key',
    callbackKeyId: 'key-1',
    callbackConfigured: false,
    callbackScopes: [],
    healthCheckedAt: null,
    healthOk: null,
    healthError: null,
    source: 'CONNECTION',
    ...patch,
  };
}

function endpoint(patch: Record<string, unknown> = {}) {
  return {
    id: '',
    name: 'Mandant angelegt',
    productionUrl: 'https://n8n.example.com/webhook/client-created',
    testUrl: 'https://n8n.example.com/webhook-test/client-created',
    workflowId: '',
    workflowName: '',
    workflowNodeId: '',
    enabled: true,
    testMode: false,
    events: ['client.created'],
    ...patch,
  };
}

const issues = (result: { success: boolean; error?: { issues: unknown[] } }) =>
  (result.error?.issues ?? []) as Array<{ path: PropertyKey[]; message: string }>;

describe('ConnectionSchema', () => {
  it('nimmt HTTP(S)-Adressen und leere optionale Adressen an', () => {
    const parsed = ConnectionSchema.safeParse(connection({ name: '  Kanzlei  ', uiBaseUrl: '' }));
    expect(parsed.success && parsed.data.name).toBe('Kanzlei');
  });

  it('lehnt andere Protokolle mit verständlicher Meldung ab', () => {
    const parsed = ConnectionSchema.safeParse(connection({ webhookBaseUrl: 'ftp://n8n.local/x' }));
    expect(issues(parsed).map((issue) => issue.message)).toEqual([
      'Es sind nur HTTP- und HTTPS-Adressen erlaubt.',
    ]);
  });

  // zod 4 führt die Protokoll-Prüfung auch nach einem gescheiterten .url() aus;
  // eine unparsbare Adresse darf dort nicht als TypeError durchschlagen.
  it('meldet eine Adresse ohne Schema als Validierungsfehler statt zu werfen', () => {
    for (const webhookBaseUrl of ['n8n.local/webhook', 'http//kaputt', ' ']) {
      const parsed = ConnectionSchema.safeParse(connection({ webhookBaseUrl }));
      expect(parsed.success).toBe(false);
      expect(issues(parsed).map((issue) => issue.path.join('.'))).toContain('webhookBaseUrl');
    }
  });
});

describe('EndpointSchema', () => {
  it('trennt Produktions- und Test-URL auch bei kodierten Pfaden', () => {
    for (const productionUrl of [
      'https://n8n.example.com/webhook-test/x',
      'https://n8n.example.com/WEBHOOK-TEST/x',
      'https://n8n.example.com/webhook%2Dtest/x',
    ]) {
      expect(issues(EndpointSchema.safeParse(endpoint({ productionUrl })))[0]?.message).toBe(
        'Die Produktions-URL darf keine n8n-Test-URL (/webhook-test/) sein.',
      );
    }
    expect(
      issues(
        EndpointSchema.safeParse(endpoint({ testUrl: 'https://n8n.example.com/webhook/x' })),
      )[0]?.message,
    ).toBe('Die Test-URL muss eine getrennte n8n-Test-URL mit /webhook-test/ sein.');
  });

  it('verlangt für Test-Modus und Fach-Events eine Test-URL, nicht für taxtronik.ping', () => {
    expect(
      issues(EndpointSchema.safeParse(endpoint({ testUrl: '', testMode: true }))).map(
        (issue) => issue.path,
      ),
    ).toEqual([['testMode'], ['testUrl']]);
    expect(
      EndpointSchema.safeParse(endpoint({ testUrl: '', events: ['taxtronik.ping'] })).success,
    ).toBe(true);
  });

  it('kennt nur katalogisierte Events und braucht mindestens eines', () => {
    expect(issues(EndpointSchema.safeParse(endpoint({ events: ['client.deleted'] })))).toEqual([
      expect.objectContaining({ message: 'Unbekanntes Event.' }),
    ]);
    expect(issues(EndpointSchema.safeParse(endpoint({ events: [] })))).toEqual([
      expect.objectContaining({ message: 'Mindestens ein Event auswählen.' }),
    ]);
    const parsed = EndpointSchema.safeParse(endpoint({ events: ['workflow.step.versand'] }));
    expect(parsed.success && parsed.data.source).toBe('CUSTOM');
  });
});

describe('WorkflowImportSchema', () => {
  it('setzt leere Einrichtungswerte und prüft die Empfänger-Adresse', () => {
    expect(WorkflowImportSchema.parse({ templateIds: ['a'] })).toEqual({
      templateIds: ['a'],
      smtpFrom: '',
      gwgOfficerEmail: '',
    });
    expect(
      WorkflowImportSchema.safeParse({ templateIds: [], gwgOfficerEmail: 'keine-adresse' }).success,
    ).toBe(false);
  });
});

describe('URL-Regeln', () => {
  it('vergleicht Hosts über den Origin; leere oder ungültige Adressen sind nie gleich', () => {
    expect(sameUrlOrigin('https://a.example/api/v1', 'https://a.example/other')).toBe(true);
    expect(sameUrlOrigin('https://a.example', 'https://a.example:8443')).toBe(false);
    expect(sameUrlOrigin('', 'https://a.example')).toBe(false);
  });

  it('verlangt zum API-Key die Public-API-Adresse, nicht umgekehrt', () => {
    expect(n8nApiConfigurationError('', 'key')).toBe(
      'Zum n8n-API-Key fehlt die Public-API-Adresse.',
    );
    expect(n8nApiConfigurationError('https://n8n.example.com/api/v1', '')).toBeNull();
  });

  it('leitet Test-Präfix, Ziel-URLs und SSRF-Zielart ab', () => {
    expect(testWebhookPrefix('https://n8n.example.com/webhook/')).toBe(
      'https://n8n.example.com/webhook-test',
    );
    expect(testWebhookPrefix('https://n8n.example.com/hooks')).toBe('');
    expect(joinWebhookUrl('https://n8n.example.com/webhook/', '/client-created')).toBe(
      'https://n8n.example.com/webhook/client-created',
    );
    expect(webhookTargetKind(true)).toBe('webhook-test');
    expect(webhookTargetKind(false)).toBe('webhook');
  });
});

describe('Verbindung speichern', () => {
  it('sendet einen behaltenen API-Key nie an eine andere Instanz', () => {
    const keep = connection({ keepApiKey: true, apiBaseUrl: 'https://other.example/api/v1' });
    expect(storedApiKeyLeavesInstance(stored(), keep)).toBe(true);
    expect(storedApiKeyLeavesInstance(stored(), { ...keep, keepApiKey: false })).toBe(false);
    expect(
      storedApiKeyLeavesInstance(stored(), {
        ...keep,
        apiBaseUrl: 'https://n8n.example.com/api/v2',
      }),
    ).toBe(false);
    // Eine leere Alt-URL blockiert keine Neueingabe.
    expect(storedApiKeyLeavesInstance(stored({ apiBaseUrl: '' }), keep)).toBe(false);
  });

  it('übernimmt beim Behalten die gespeicherten Secrets', () => {
    expect(
      effectiveConnectionSecrets(stored(), connection({ keepHmac: true, keepApiKey: true })),
    ).toEqual({
      hmacSecret: 'stored-secret-with-at-least-32-characters',
      apiKey: 'stored-api-key',
    });
    expect(effectiveConnectionSecrets(stored(), connection())).toEqual({
      hmacSecret: SECRET,
      apiKey: 'api-key',
    });
  });

  it('lehnt in fester Reihenfolge ab und lässt eine gültige Verbindung zu', () => {
    const reject = (data: N8nConnectionInput, previous = stored()) =>
      connectionSaveRejection(previous, data, effectiveConnectionSecrets(previous, data));

    expect(reject(connection({ hmacSecret: 'kurz', apiBaseUrl: '' }))).toBe(
      'Das Signatur-Secret muss mindestens 32 Zeichen lang sein.',
    );
    expect(reject(connection({ apiBaseUrl: '' }))).toBe(
      'Zum n8n-API-Key fehlt die Public-API-Adresse.',
    );
    expect(
      reject(connection({ keepApiKey: true, apiBaseUrl: 'https://other.example/api/v1' })),
    ).toContain('zeigt auf eine andere n8n-Instanz');
    expect(reject(connection({ routingMode: 'LEGACY' }))).toBe(
      'Der Legacy-Modus benötigt Webhook-Präfix und Signatur-Secret.',
    );
    expect(
      reject(
        connection({ routingMode: 'LEGACY', webhookBaseUrl: 'https://n8n.example.com/webhook' }),
      ),
    ).toBeNull();
    // Die verwaltete Instanz darf ihre API-Adresse zunächst ohne Key speichern.
    expect(reject(connection({ apiKey: '' }))).toBeNull();
  });

  it('normalisiert Adressen, Aktivierung und Quelle; übrige Werte bleiben', () => {
    const data = connection({
      name: 'Kanzlei',
      routingMode: 'DISABLED',
      enabled: true,
      uiBaseUrl: ' https://n8n.example.com/ ',
      webhookBaseUrl: 'https://n8n.example.com/webhook/',
      apiBaseUrl: 'https://n8n.example.com/api/v1/',
    });
    const cfg = normalizedConnectionConfig(
      stored({ source: 'LEGACY_SETTING' }),
      data,
      { hmacSecret: SECRET, apiKey: 'api-key' },
      'https://app.example.com/',
    );
    expect(cfg).toEqual({
      ...stored(),
      name: 'Kanzlei',
      kind: 'SELF_HOSTED',
      routingMode: 'DISABLED',
      enabled: false,
      uiBaseUrl: 'https://n8n.example.com',
      callbackBaseUrl: 'https://app.example.com',
      webhookBaseUrl: 'https://n8n.example.com/webhook',
      hmacSecret: SECRET,
      apiBaseUrl: 'https://n8n.example.com/api/v1',
      apiKey: 'api-key',
      source: 'CONNECTION',
    });
  });

  it('erkennt Signatur- und zustellrelevante Änderungen', () => {
    const previous = stored();
    expect(connectionChange(previous, { ...previous })).toEqual({
      signingSecretChanged: false,
      deliveryConfigurationChanged: false,
    });
    expect(connectionChange(previous, { ...previous, hmacSecret: SECRET })).toEqual({
      signingSecretChanged: true,
      deliveryConfigurationChanged: true,
    });
    expect(
      connectionChange({ ...previous, connectionId: null }, previous).deliveryConfigurationChanged,
    ).toBe(true);
    expect(
      connectionChange(previous, { ...previous, enabled: false }).deliveryConfigurationChanged,
    ).toBe(true);
    // Das Webhook-Präfix zählt nur im Legacy-Routing (vorher oder nachher).
    const moved = { ...previous, webhookBaseUrl: 'https://n8n.example.com/webhook' };
    expect(connectionChange(previous, moved).deliveryConfigurationChanged).toBe(false);
    expect(
      connectionChange({ ...previous, routingMode: 'LEGACY' }, { ...moved, routingMode: 'LEGACY' })
        .deliveryConfigurationChanged,
    ).toBe(true);
  });
});

describe('endpointRouteChange', () => {
  const exists = {
    productionUrl: 'https://n8n.example.com/webhook/a',
    testUrl: null as string | null,
    enabled: true,
    testMode: false,
    subscriptions: [{ event: 'request.opened' }, { event: 'client.created' }],
  };
  const next = {
    productionUrl: exists.productionUrl,
    testUrl: '',
    enabled: true,
    testMode: false,
    events: ['client.created', 'request.opened', 'client.created'],
  };

  it('ignoriert Reihenfolge und Dubletten der Events sowie null gegen leere Test-URL', () => {
    expect(endpointRouteChange(exists, next)).toEqual({ routeChanged: false, cancelReason: null });
    expect(endpointRouteChange({ ...exists, enabled: false }, next)).toEqual({
      routeChanged: false,
      cancelReason: null,
    });
  });

  it('setzt bei geänderten Zielen oder Events die Verifikation zurück', () => {
    expect(
      endpointRouteChange(exists, { ...next, productionUrl: 'https://n8n.example.com/webhook/b' }),
    ).toEqual({
      routeChanged: true,
      cancelReason: 'n8n-Route oder Event-Zuordnung wurde geändert',
    });
    expect(endpointRouteChange(exists, { ...next, events: ['client.created'] })).toEqual({
      routeChanged: true,
      cancelReason: 'n8n-Route oder Event-Zuordnung wurde geändert',
    });
  });

  it('bricht beim Test-Modus-Wechsel und beim Deaktivieren ab, ohne neu zu verifizieren', () => {
    expect(endpointRouteChange(exists, { ...next, testMode: true })).toEqual({
      routeChanged: false,
      cancelReason: 'Test-Modus der n8n-Route wurde umgeschaltet',
    });
    expect(endpointRouteChange(exists, { ...next, enabled: false })).toEqual({
      routeChanged: false,
      cancelReason: 'n8n-Route wurde deaktiviert',
    });
  });
});

describe('Webhook-Test', () => {
  const envelope = {
    eventId: '00000000-0000-4000-8000-0000000000e1',
    deliveryId: '00000000-0000-4000-8000-0000000000d1',
    tenantId: '00000000-0000-4000-8000-000000000001',
    occurredAt: new Date('2026-10-06T08:00:00.000Z'),
  };

  it('baut den signierten Body in fester Feldreihenfolge mit Beispiel-Payload', () => {
    const entry = N8N_EVENT_CATALOG.find((item) => item.name === 'client.created')!;
    expect(syntheticN8nTestEvent({ ...envelope, event: 'client.created' })).toBe(
      JSON.stringify({
        schemaVersion: 1,
        eventId: envelope.eventId,
        deliveryId: envelope.deliveryId,
        event: 'client.created',
        tenantId: envelope.tenantId,
        occurredAt: '2026-10-06T08:00:00.000Z',
        payload: { ...entry.examplePayload, synthetic: true },
      }),
    );
    expect(
      JSON.parse(syntheticN8nTestEvent({ ...envelope, event: 'workflow.step.versand' })).payload,
    ).toEqual({ from: 'taxtronik-settings-ui', synthetic: true });
  });

  it('verlangt die Challenge nur für taxtronik.ping', () => {
    const challenge = JSON.stringify({
      challenge: 'taxtronik-connection-ok',
      event: 'taxtronik.ping',
    });
    expect(pingChallengeOk('taxtronik.ping', challenge)).toBe(true);
    expect(pingChallengeOk('taxtronik.ping', '{"challenge":"falsch"}')).toBe(false);
    expect(pingChallengeOk('taxtronik.ping', 'kein json')).toBe(false);
    expect(pingChallengeOk('client.created', '')).toBe(true);
  });

  it('beschreibt HTTP-Fehler und fehlende Challenge', () => {
    expect(webhookVerificationError({ ok: false, status: 502 }, '', true)).toBe(
      'HTTP 502: leere Antwort',
    );
    expect(webhookVerificationError({ ok: false, status: 404 }, 'nicht gefunden', true)).toBe(
      'HTTP 404: nicht gefunden',
    );
    expect(webhookVerificationError({ ok: true, status: 200 }, '{}', false)).toBe(
      'Antwort enthält nicht die erwartete TaxTronik-Challenge.',
    );
    expect(webhookVerificationError({ ok: true, status: 200 }, '{}', true)).toBeNull();
  });
});
