// =============================================================================
// Unit-Tests: n8n-Routing-API (R-01) — Zielauswahl, Secret-Vorrang,
// Routenprüfung und Job-Optionen als eine API für Web und Worker.
// =============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  env: { N8N_HMAC_SECRET: '', N8N_WEBHOOK_BASE_URL: '' } as {
    N8N_HMAC_SECRET?: string;
    N8N_WEBHOOK_BASE_URL?: string;
  },
}));

vi.mock('@taxtronik/config', () => ({ env: h.env, n8nDeliveryMode: 'production' }));

import {
  checkPlannedN8nRoute,
  DELIVERY_JOB_OPTIONS,
  hasN8nSigningSecret,
  legacyN8nTargetUrl,
  N8N_ROUTE_CHANGE_REASONS,
  N8N_TEST_WEBHOOK_MISSING,
  n8nDeliveryConfigFrom,
  n8nDeliveryJob,
  n8nLegacyOutboxJob,
  n8nRoutingState,
  plannedN8nTarget,
  resolveN8nSigningSecret,
  type N8nPlannedDeliverySnapshot,
  type N8nRoutingConnection,
  type N8nRoutingState,
  type N8nSecretFieldReader,
} from '../routing';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PRODUCTION_URL = 'https://n8n.example.com/webhook/request-opened';
const TEST_URL = 'https://n8n.example.com/webhook-test/request-opened';

const CONNECTION: N8nRoutingConnection = {
  id: 'connection-1',
  name: 'Kanzlei n8n',
  enabled: true,
  routingMode: 'EXPLICIT',
  webhookBaseUrl: null,
  signingSecretEncrypted: 'v3:connection-blob',
};

beforeEach(() => {
  h.env.N8N_HMAC_SECRET = '';
  h.env.N8N_WEBHOOK_BASE_URL = '';
});

describe('plannedN8nTarget', () => {
  const endpoint = { productionUrl: PRODUCTION_URL, testUrl: TEST_URL, testMode: false };

  it('liefert im Produktionsmodus die Produktions-URL', () => {
    expect(plannedN8nTarget(endpoint, 'production')).toEqual({
      useTestUrl: false,
      targetUrl: PRODUCTION_URL,
      skipReason: null,
    });
  });

  it('beachtet den Debug-Schalter testMode der Route auch im Produktionsmodus', () => {
    expect(plannedN8nTarget({ ...endpoint, testMode: true }, 'production')).toEqual({
      useTestUrl: true,
      targetUrl: TEST_URL,
      skipReason: null,
    });
  });

  it('liefert im globalen Testmodus immer an die Test-URL', () => {
    expect(plannedN8nTarget(endpoint, 'test').targetUrl).toBe(TEST_URL);
  });

  it('bleibt im Log-Modus beim Produktionsziel (der Worker sendet dann nicht)', () => {
    expect(plannedN8nTarget(endpoint, 'log').targetUrl).toBe(PRODUCTION_URL);
  });

  it('überspringt ein verlangtes Test-Ziel ohne hinterlegte Test-URL', () => {
    expect(plannedN8nTarget({ ...endpoint, testUrl: null, testMode: true }, 'production')).toEqual({
      useTestUrl: true,
      targetUrl: null,
      skipReason: N8N_TEST_WEBHOOK_MISSING,
    });
  });
});

describe('legacyN8nTargetUrl', () => {
  it('hängt das Event kodiert an den Präfix ohne doppelte Schrägstriche', () => {
    expect(
      legacyN8nTargetUrl('https://n8n.example/webhook//', 'request.opened', 'production'),
    ).toBe('https://n8n.example/webhook/request.opened');
    expect(legacyN8nTargetUrl('https://n8n.example/hooks', 'workflow.step.a b', 'production')).toBe(
      'https://n8n.example/hooks/workflow.step.a%20b',
    );
  });

  it('wechselt im globalen Testmodus /webhook gegen /webhook-test', () => {
    expect(legacyN8nTargetUrl('https://n8n.example/webhook', 'request.opened', 'test')).toBe(
      'https://n8n.example/webhook-test/request.opened',
    );
  });
});

describe('Signatur-Secret: eine Vorrangregel (Connection → Legacy-Eintrag → ENV)', () => {
  const reader = vi.fn<N8nSecretFieldReader>();

  beforeEach(() => {
    reader.mockReset();
    reader.mockImplementation(({ encrypted, legacyPlain }) =>
      encrypted ? `decrypted(${encrypted})` : (legacyPlain ?? ''),
    );
    h.env.N8N_HMAC_SECRET = 'global-env-secret-with-at-least-32-chars';
    h.env.N8N_WEBHOOK_BASE_URL = 'https://env.example/webhook';
  });

  it('verwendet bei vorhandener Connection ausschließlich deren Secret im S-08-Slot', () => {
    const config = n8nDeliveryConfigFrom({
      tenantId: TENANT,
      connection: CONNECTION,
      legacySetting: { hmacSecret: 'legacy-plain', webhookBaseUrl: 'https://legacy/webhook' },
    });

    expect(config.secretSource).toEqual({
      kind: 'CONNECTION',
      slot: 'n8nSigningSecret',
      tenantId: TENANT,
      encrypted: 'v3:connection-blob',
    });
    expect(resolveN8nSigningSecret(config.secretSource, reader)).toBe(
      'decrypted(v3:connection-blob)',
    );
    expect(reader).toHaveBeenCalledWith({
      slot: 'n8nSigningSecret',
      fieldName: 'n8n.signingSecret',
      tenantId: TENANT,
      encrypted: 'v3:connection-blob',
      legacyPlain: null,
    });
    expect(config.legacyWebhookBaseUrl).toBe('');
  });

  it('fällt bei Connection ohne Secret weder auf Legacy noch auf ENV zurück', () => {
    const config = n8nDeliveryConfigFrom({
      tenantId: TENANT,
      connection: { ...CONNECTION, signingSecretEncrypted: null },
      legacySetting: { hmacSecret: 'legacy-plain' },
    });

    expect(hasN8nSigningSecret(config.secretSource)).toBe(false);
    expect(resolveN8nSigningSecret(config.secretSource, reader)).toBe('');
    expect(reader).not.toHaveBeenCalled();
  });

  it('liest ohne Connection den Legacy-Eintrag im Legacy-Slot (verschlüsselt vor Klartext)', () => {
    const config = n8nDeliveryConfigFrom({
      tenantId: TENANT,
      connection: null,
      legacySetting: {
        webhookBaseUrl: ' https://legacy.example/webhook ',
        hmacEncrypted: 'v3:legacy-blob',
        hmacSecret: 'legacy-plain',
      },
    });

    expect(config.legacyWebhookBaseUrl).toBe('https://legacy.example/webhook');
    expect(resolveN8nSigningSecret(config.secretSource, reader)).toBe('decrypted(v3:legacy-blob)');
    expect(reader).toHaveBeenCalledWith({
      slot: 'legacyN8nHmacSecret',
      fieldName: 'n8n.hmacSecret',
      tenantId: TENANT,
      encrypted: 'v3:legacy-blob',
      legacyPlain: 'legacy-plain',
    });
  });

  it('ergänzt einen Legacy-Eintrag ohne Secret oder Präfix nicht feldweise aus ENV', () => {
    const config = n8nDeliveryConfigFrom({
      tenantId: TENANT,
      connection: null,
      legacySetting: { apiBaseUrl: 'https://n8n.example/api/v1' },
    });

    expect(config.secretSource.kind).toBe('LEGACY_SETTING');
    expect(hasN8nSigningSecret(config.secretSource)).toBe(false);
    expect(resolveN8nSigningSecret(config.secretSource, reader)).toBe('');
    expect(config.legacyWebhookBaseUrl).toBe('');
  });

  it.each([null, 'kaputt', 42])(
    'behandelt einen unlesbaren Legacy-Wert (%s) als leeren Eintrag statt als ENV-Freigabe',
    (value) => {
      const config = n8nDeliveryConfigFrom({
        tenantId: TENANT,
        connection: null,
        legacySetting: value,
      });

      expect(config.secretSource).toEqual({
        kind: 'LEGACY_SETTING',
        slot: 'legacyN8nHmacSecret',
        tenantId: TENANT,
        encrypted: null,
        plain: null,
      });
      expect(config.legacyWebhookBaseUrl).toBe('');
    },
  );

  it('verwendet ENV nur ohne Connection und ohne Legacy-Eintrag', () => {
    const config = n8nDeliveryConfigFrom({ tenantId: TENANT, connection: null });

    expect(config.secretSource).toEqual({
      kind: 'ENV',
      plain: 'global-env-secret-with-at-least-32-chars',
    });
    expect(resolveN8nSigningSecret(config.secretSource, reader)).toBe(
      'global-env-secret-with-at-least-32-chars',
    );
    expect(config.legacyWebhookBaseUrl).toBe('https://env.example/webhook');
    expect(reader).not.toHaveBeenCalled();
  });

  it('kennt ohne Tenant nur ENV (Systemereignisse)', () => {
    const config = n8nDeliveryConfigFrom({ tenantId: null, connection: null, legacySetting: {} });
    expect(config.secretSource.kind).toBe('ENV');
  });

  it('meldet ohne ENV-Secret keine Quelle als vorhanden', () => {
    h.env.N8N_HMAC_SECRET = '';
    const config = n8nDeliveryConfigFrom({ tenantId: TENANT, connection: null });
    expect(hasN8nSigningSecret(config.secretSource)).toBe(false);
    expect(resolveN8nSigningSecret(config.secretSource, reader)).toBe('');
  });
});

describe('checkPlannedN8nRoute', () => {
  const endpoint = {
    enabled: true,
    connectionId: CONNECTION.id,
    productionUrl: PRODUCTION_URL,
    testUrl: TEST_URL,
    testMode: false,
    subscriptions: [{ event: 'request.opened' }],
  };
  const explicitDelivery: N8nPlannedDeliverySnapshot = {
    targetUrl: PRODUCTION_URL,
    connectionIdSnapshot: CONNECTION.id,
    event: 'request.opened',
    endpoint,
  };
  const explicitState: N8nRoutingState = n8nRoutingState(
    n8nDeliveryConfigFrom({ tenantId: TENANT, connection: CONNECTION }),
  );

  it('lässt eine unveränderte explizite Route zu', () => {
    expect(checkPlannedN8nRoute(explicitDelivery, explicitState, 'production')).toEqual({
      ok: true,
      targetUrl: PRODUCTION_URL,
      useTestUrl: false,
    });
  });

  it('erkennt eine an die Test-URL geplante Route im testMode als unverändert', () => {
    const delivery = {
      ...explicitDelivery,
      targetUrl: TEST_URL,
      endpoint: { ...endpoint, testMode: true },
    };
    expect(checkPlannedN8nRoute(delivery, explicitState, 'production')).toEqual({
      ok: true,
      targetUrl: TEST_URL,
      useTestUrl: true,
    });
  });

  it('verwirft einen Produktions-Snapshot, wenn die Route inzwischen im testMode ist', () => {
    const delivery = { ...explicitDelivery, endpoint: { ...endpoint, testMode: true } };
    expect(checkPlannedN8nRoute(delivery, explicitState, 'production')).toEqual({
      ok: false,
      reason: N8N_ROUTE_CHANGE_REASONS.explicitRouteChanged,
    });
  });

  it.each([
    ['deaktivierter Route', { endpoint: { ...endpoint, enabled: false } }],
    [
      'geänderter Ziel-URL',
      { endpoint: { ...endpoint, productionUrl: 'https://n8n/webhook/neu' } },
    ],
    ['entferntem Abo', { endpoint: { ...endpoint, subscriptions: [] } }],
    ['fremder Connection', { endpoint: { ...endpoint, connectionId: 'connection-2' } }],
  ])('verwirft den Snapshot bei %s', (_label, patch) => {
    expect(
      checkPlannedN8nRoute({ ...explicitDelivery, ...patch }, explicitState, 'production'),
    ).toEqual({ ok: false, reason: N8N_ROUTE_CHANGE_REASONS.explicitRouteChanged });
  });

  it('stellt eine explizite Delivery nach Wechsel in den LEGACY-Modus nicht mehr zu', () => {
    const state = { ...explicitState, routingMode: 'LEGACY' as const };
    expect(checkPlannedN8nRoute(explicitDelivery, state, 'production')).toEqual({
      ok: false,
      reason: N8N_ROUTE_CHANGE_REASONS.explicitRouteChanged,
    });
  });

  it('prüft zuerst die bewusste Deaktivierung, dann die Connection-Identität', () => {
    expect(
      checkPlannedN8nRoute(explicitDelivery, { ...explicitState, disabled: true }, 'production'),
    ).toEqual({ ok: false, reason: N8N_ROUTE_CHANGE_REASONS.disabled });
    expect(
      checkPlannedN8nRoute(
        explicitDelivery,
        { ...explicitState, connectionId: 'connection-2' },
        'production',
      ),
    ).toEqual({ ok: false, reason: N8N_ROUTE_CHANGE_REASONS.connectionReplaced });
  });

  it('verlangt nach allen Routenprüfungen ein nutzbares Signatur-Secret', () => {
    expect(
      checkPlannedN8nRoute(
        explicitDelivery,
        { ...explicitState, signingSecretAvailable: false },
        'production',
      ),
    ).toEqual({ ok: false, reason: N8N_ROUTE_CHANGE_REASONS.secretMissing });
    expect(
      checkPlannedN8nRoute(
        {
          ...explicitDelivery,
          targetUrl: null,
          endpoint: { ...endpoint, testUrl: null, testMode: true },
        },
        explicitState,
        'production',
      ),
    ).toEqual({ ok: false, reason: N8N_ROUTE_CHANGE_REASONS.targetMissing });
  });

  describe('Legacy-Deliveries', () => {
    const legacyState: N8nRoutingState = n8nRoutingState(
      n8nDeliveryConfigFrom({
        tenantId: TENANT,
        connection: null,
        legacySetting: { webhookBaseUrl: 'https://n8n.example/webhook', hmacSecret: 'plain' },
      }),
    );
    const legacyDelivery: N8nPlannedDeliverySnapshot = {
      targetUrl: 'https://n8n.example/webhook/request.opened',
      connectionIdSnapshot: null,
      event: 'request.opened',
      endpoint: null,
    };

    it('lässt ein unverändertes Legacy-Ziel zu', () => {
      expect(checkPlannedN8nRoute(legacyDelivery, legacyState, 'production')).toEqual({
        ok: true,
        targetUrl: legacyDelivery.targetUrl,
        useTestUrl: false,
      });
    });

    it('verwirft ein geändertes Legacy-Präfix', () => {
      const state = { ...legacyState, legacyWebhookBaseUrl: 'https://anders.example/webhook' };
      expect(checkPlannedN8nRoute(legacyDelivery, state, 'production')).toEqual({
        ok: false,
        reason: N8N_ROUTE_CHANGE_REASONS.legacyTargetChanged,
      });
    });

    it('verwirft Legacy- und verwaiste Deliveries im expliziten Modus', () => {
      const state = { ...legacyState, routingMode: 'EXPLICIT' as const };
      expect(checkPlannedN8nRoute(legacyDelivery, state, 'production')).toEqual({
        ok: false,
        reason: N8N_ROUTE_CHANGE_REASONS.explicitRouteChanged,
      });
    });
  });
});

describe('n8nRoutingState', () => {
  it.each([
    [{ enabled: false, routingMode: 'EXPLICIT' as const }, true],
    [{ enabled: true, routingMode: 'DISABLED' as const }, true],
    [{ enabled: true, routingMode: 'LEGACY' as const }, false],
  ])('leitet die bewusste Deaktivierung aus %o ab', (patch, disabled) => {
    const state = n8nRoutingState(
      n8nDeliveryConfigFrom({ tenantId: TENANT, connection: { ...CONNECTION, ...patch } }),
    );
    expect(state.disabled).toBe(disabled);
    expect(state.signingSecretAvailable).toBe(true);
  });
});

describe('Delivery-Jobs', () => {
  it('verwendet für Erstplanung und PENDING-Reconcile den deduplizierenden Key', () => {
    expect(n8nDeliveryJob('d-1')).toEqual({
      name: 'deliver',
      data: { deliveryId: 'd-1' },
      opts: { ...DELIVERY_JOB_OPTIONS, jobId: 'delivery-d-1' },
    });
  });

  it('erzeugt für Admin-Retry und Lease-Recovery eigene Keys mit denselben Optionen', () => {
    const now = new Date('2026-07-14T12:03:00.000Z');
    const bucket = Math.floor(now.getTime() / (5 * 60_000));
    expect(n8nDeliveryJob('d-1', { kind: 'manual-retry', nonce: 'n-1' }).opts).toEqual({
      ...DELIVERY_JOB_OPTIONS,
      jobId: 'manual-retry-d-1-n-1',
    });
    expect(n8nDeliveryJob('d-1', { kind: 'recovery', now }).opts.jobId).toBe(
      `recovery-delivery-d-1-${bucket}`,
    );
  });

  it('reiht rolling-deploy-Altjobs über die Outbox-ID ein', () => {
    expect(n8nLegacyOutboxJob('o-1')).toEqual({
      name: 'deliver',
      data: { outboxId: 'o-1' },
      opts: { ...DELIVERY_JOB_OPTIONS, jobId: 'outbox-o-1' },
    });
  });

  it('hält die Retry-Politik stabil (6 Versuche, exponentiell ab 60 s)', () => {
    expect(DELIVERY_JOB_OPTIONS).toEqual({
      attempts: 6,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: { age: 86_400 },
      removeOnFail: { age: 604_800 },
    });
  });
});
