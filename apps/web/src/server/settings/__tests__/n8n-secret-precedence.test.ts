// =============================================================================
// R-01: Die n8n-Einstellungen lösen das Signatur-Secret über dieselbe
// Vorrangregel wie Outbox-Planung und Worker auf (@taxtronik/n8n-shared):
// Connection → Legacy-Eintrag als Ganzes → ENV, ohne feldweises Auffüllen.
// Echte Secret-Box-Blobs belegen die unveränderten S-08-Kontexte.
// =============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const tx = {
    n8nConnection: { findUnique: vi.fn() },
    tenantSetting: { findUnique: vi.fn() },
  };
  return {
    tx,
    warn: vi.fn(),
    env: {
      NODE_ENV: 'test',
      NEXTAUTH_URL: 'http://localhost:3000',
      AUTH_SECRET: 'unit-test-auth-secret-with-at-least-32-chars',
      N8N_HMAC_SECRET: '',
      N8N_WEBHOOK_BASE_URL: '',
    },
  };
});

vi.mock('@taxtronik/config', () => ({ env: h.env, n8nDeliveryMode: 'production' }));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: (_ctx: unknown, fn: (tx: typeof h.tx) => unknown) => fn(h.tx),
}));
vi.mock('@/server/logger', () => ({ log: { warn: h.warn } }));

import { encryptSecret, SECRET_SLOTS, secretSlotContext } from '@taxtronik/crypto';
import { resolveN8nConfig } from '../n8n';

const TENANT = '00000000-0000-4000-8000-000000000001';
const ctx = { tenantId: TENANT, actorId: 'staff-1', actorType: 'STAFF' as const };

function legacyRow(value: Record<string, unknown>) {
  return { value };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.env.N8N_HMAC_SECRET = 'global-env-secret-with-at-least-32-chars';
  h.env.N8N_WEBHOOK_BASE_URL = 'https://env.example/webhook';
  h.tx.n8nConnection.findUnique.mockResolvedValue(null);
  h.tx.tenantSetting.findUnique.mockResolvedValue(null);
});

describe('resolveN8nConfig — Signatur-Secret', () => {
  it('entschlüsselt das Connection-Secret im Connection-Slot und liest kein Legacy/ENV', async () => {
    h.tx.n8nConnection.findUnique.mockResolvedValue({
      id: 'connection-1',
      name: 'Kanzlei n8n',
      kind: 'SELF_HOSTED',
      routingMode: 'EXPLICIT',
      enabled: true,
      uiBaseUrl: null,
      callbackBaseUrl: null,
      webhookBaseUrl: null,
      apiBaseUrl: null,
      apiKeyEncrypted: null,
      signingSecretEncrypted: encryptSecret(
        'connection-secret',
        secretSlotContext(SECRET_SLOTS.n8nSigningSecret, { tenantId: TENANT }),
      ),
      callbackKeyId: 'key-1',
      callbackTokenHash: null,
      callbackScopes: [],
      healthCheckedAt: null,
      healthOk: null,
      healthError: null,
    });

    const cfg = await resolveN8nConfig(ctx);

    expect(cfg.hmacSecret).toBe('connection-secret');
    expect(cfg.source).toBe('CONNECTION');
    expect(h.tx.tenantSetting.findUnique).not.toHaveBeenCalled();
  });

  it('entschlüsselt ohne Connection das Legacy-Secret im Legacy-Slot', async () => {
    h.tx.tenantSetting.findUnique.mockResolvedValue(
      legacyRow({
        webhookBaseUrl: 'https://legacy.example/webhook',
        hmacEncrypted: encryptSecret(
          'legacy-secret',
          secretSlotContext(SECRET_SLOTS.legacyN8nHmacSecret, { tenantId: TENANT }),
        ),
      }),
    );

    const cfg = await resolveN8nConfig(ctx);

    expect(cfg).toMatchObject({
      source: 'LEGACY_SETTING',
      hmacSecret: 'legacy-secret',
      webhookBaseUrl: 'https://legacy.example/webhook',
      routingMode: 'LEGACY',
      enabled: true,
    });
  });

  it('ergänzt einen Legacy-Eintrag ohne Secret oder Präfix nicht aus ENV', async () => {
    h.tx.tenantSetting.findUnique.mockResolvedValue(
      legacyRow({ apiBaseUrl: 'https://n8n.example/api/v1' }),
    );

    const cfg = await resolveN8nConfig(ctx);

    expect(cfg).toMatchObject({
      source: 'LEGACY_SETTING',
      hmacSecret: '',
      webhookBaseUrl: '',
      routingMode: 'DISABLED',
      enabled: false,
      apiBaseUrl: 'https://n8n.example/api/v1',
    });
  });

  it('fällt bei nicht entschlüsselbarem Legacy-Secret nicht auf Klartext zurück und protokolliert das', async () => {
    h.tx.tenantSetting.findUnique.mockResolvedValue(
      legacyRow({
        webhookBaseUrl: 'https://legacy.example/webhook',
        // In einen fremden Tenant kopierter Wert (S-08) neben einem Klartext-Altwert.
        hmacEncrypted: encryptSecret(
          'fremdes-secret',
          secretSlotContext(SECRET_SLOTS.legacyN8nHmacSecret, { tenantId: 'tenant-2' }),
        ),
        hmacSecret: 'veralteter-klartext',
      }),
    );

    const cfg = await resolveN8nConfig(ctx);

    expect(cfg.hmacSecret).toBe('');
    expect(cfg.enabled).toBe(false);
    expect(h.warn).toHaveBeenCalledWith(
      expect.objectContaining({ field: 'n8n.hmacSecret' }),
      expect.any(String),
    );
  });

  it('verwendet ENV nur ohne Connection und ohne Legacy-Eintrag', async () => {
    const cfg = await resolveN8nConfig(ctx);

    expect(cfg).toMatchObject({
      source: 'ENV',
      hmacSecret: 'global-env-secret-with-at-least-32-chars',
      webhookBaseUrl: 'https://env.example/webhook',
      routingMode: 'LEGACY',
    });
  });

  it('behandelt einen leeren Legacy-Wert als vorhandenen Eintrag ohne ENV-Fallback', async () => {
    h.tx.tenantSetting.findUnique.mockResolvedValue({ value: null });

    const cfg = await resolveN8nConfig(ctx);

    expect(cfg).toMatchObject({ source: 'LEGACY_SETTING', hmacSecret: '', webhookBaseUrl: '' });
  });
});
