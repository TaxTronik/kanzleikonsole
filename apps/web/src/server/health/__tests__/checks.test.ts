import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  health: vi.fn(),
  riskLayerClient: vi.fn(),
  safeFetch: vi.fn(),
  tsaTimestamp: vi.fn(),
  withTenantContext: vi.fn(),
  tx: {
    n8nConnection: { findUnique: vi.fn() },
    tenantSetting: { findUnique: vi.fn() },
  },
  env: {
    REDIS_URL: 'redis://localhost:6379',
    S3_ENDPOINT: 'http://localhost:8333',
    S3_REGION: 'us-east-1',
    S3_ACCESS_KEY: 'test',
    S3_SECRET_KEY: 'test',
    CLAMAV_HOST: 'localhost',
    CLAMAV_PORT: 3310,
    N8N_WEBHOOK_BASE_URL: '',
    TIMESTAMP_AUTHORITY_URL: '',
  },
  riskLayerConfig: {
    url: 'http://127.0.0.1:8000',
    token: 'test-token',
  },
}));

vi.mock('@taxtronik/config', () => ({
  env: mocks.env,
  riskLayerConfig: mocks.riskLayerConfig,
}));

vi.mock('@taxtronik/db', () => ({
  prisma: {},
  withTenantContext: mocks.withTenantContext,
}));

vi.mock('@taxtronik/evidence', () => ({
  createRfc3161Adapter: vi.fn(() => ({ timestamp: mocks.tsaTimestamp })),
  resolveTsaUrl: vi.fn(
    (providerId: string | null, customUrl: string | null) =>
      customUrl ?? (providerId ? `https://tsa.example.test/${providerId}` : null),
  ),
}));

vi.mock('@taxtronik/risk-layer', () => ({
  RiskLayerClient: mocks.riskLayerClient,
}));

vi.mock('@/server/http/ssrf-guard', () => ({
  safeFetchN8n: mocks.safeFetch,
}));

import { checkN8nForTenant, checkSignalEngine, checkTsaForTenant } from '../checks';

describe('checkTsaForTenant', () => {
  beforeEach(() => {
    mocks.env.TIMESTAMP_AUTHORITY_URL = '';
    mocks.tsaTimestamp.mockReset().mockResolvedValue({ genTime: new Date() });
    mocks.tx.tenantSetting.findUnique.mockReset().mockResolvedValue(null);
    mocks.withTenantContext
      .mockReset()
      .mockImplementation(async (_ctx: unknown, callback: (tx: typeof mocks.tx) => unknown) =>
        callback(mocks.tx),
      );
  });

  it('prüft ohne Override denselben GlobalSign-Default wie der Worker', async () => {
    await expect(checkTsaForTenant('tenant-1')).resolves.toMatchObject({
      ok: true,
      source: 'default',
      url: 'https://tsa.example.test/globalsign',
    });
    expect(mocks.tsaTimestamp).toHaveBeenCalledTimes(1);
  });

  it('bevorzugt die kanzleispezifische TSA', async () => {
    mocks.tx.tenantSetting.findUnique.mockResolvedValue({
      value: { providerId: 'custom', customUrl: 'https://custom-tsa.example.test/tsr' },
    });

    await expect(checkTsaForTenant('tenant-1')).resolves.toMatchObject({
      ok: true,
      source: 'tenant',
      url: 'https://custom-tsa.example.test/tsr',
    });
  });
});

describe('checkN8nForTenant', () => {
  beforeEach(() => {
    mocks.env.N8N_WEBHOOK_BASE_URL = '';
    mocks.safeFetch.mockReset();
    mocks.tx.n8nConnection.findUnique.mockReset().mockResolvedValue(null);
    mocks.tx.tenantSetting.findUnique.mockReset().mockResolvedValue(null);
    mocks.withTenantContext
      .mockReset()
      .mockImplementation(async (_ctx: unknown, callback: (tx: typeof mocks.tx) => unknown) =>
        callback(mocks.tx),
      );
  });

  it.each(['http://localhost:5678/webhook', 'http://[::1]:5678/webhook'])(
    'ordnet die alte Loopback-ENV-Vorgabe %s als Migrationszustand ein',
    async (url) => {
      mocks.env.N8N_WEBHOOK_BASE_URL = url;

      await expect(checkN8nForTenant('tenant-1')).resolves.toEqual({
        ok: false,
        url,
        source: 'env',
        legacyMigrationRequired: true,
      });
      expect(mocks.safeFetch).not.toHaveBeenCalled();
    },
  );

  it('erkennt auch eine alte Kanzlei-Einstellung als Migrationsquelle', async () => {
    mocks.tx.tenantSetting.findUnique.mockResolvedValue({
      value: { webhookBaseUrl: 'http://localhost:5678/webhook' },
    });

    await expect(checkN8nForTenant('tenant-1')).resolves.toMatchObject({
      source: 'legacy-setting',
      legacyMigrationRequired: true,
    });
    expect(mocks.safeFetch).not.toHaveBeenCalled();
  });

  it('prüft eine öffentliche Legacy-Vorgabe weiterhin per safeFetch', async () => {
    mocks.env.N8N_WEBHOOK_BASE_URL = 'https://n8n.example.test/webhook/workflow';
    mocks.safeFetch.mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue('ok'),
    });

    await expect(checkN8nForTenant('tenant-1')).resolves.toMatchObject({
      ok: true,
      source: 'env',
    });
    expect(mocks.safeFetch).toHaveBeenCalledWith(
      'https://n8n.example.test/healthz',
      'health',
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  it('lässt normalisierte Loopback-Verbindungen weiterhin am SSRF-Guard scheitern', async () => {
    mocks.tx.n8nConnection.findUnique.mockResolvedValue({
      enabled: true,
      routingMode: 'EXPLICIT',
      uiBaseUrl: null,
      apiBaseUrl: 'http://localhost:5678/api/v1',
      webhookBaseUrl: null,
      endpoints: [],
    });
    mocks.safeFetch.mockRejectedValue(
      new Error('Hostname löst auf eine private/reservierte Adresse auf: ::1'),
    );

    const result = await checkN8nForTenant('tenant-1');

    expect(result).toMatchObject({
      ok: false,
      source: 'tenant',
      error: expect.stringContaining('private/reservierte Adresse'),
    });
    expect(result).not.toHaveProperty('legacyMigrationRequired');
    expect(mocks.safeFetch).toHaveBeenCalledTimes(1);
  });
});

describe('checkSignalEngine', () => {
  beforeEach(() => {
    mocks.riskLayerConfig.url = 'http://127.0.0.1:8000';
    mocks.health.mockReset().mockResolvedValue({ ok: true });
    mocks.riskLayerClient.mockReset().mockImplementation(function RiskLayerClientMock() {
      return { health: mocks.health };
    });
    mocks.safeFetch.mockReset();
  });

  it('nutzt den trusted RiskLayerClient statt safeFetch, damit interne IPs erlaubt sind', async () => {
    await expect(checkSignalEngine()).resolves.toMatchObject({ ok: true });

    expect(mocks.riskLayerClient).toHaveBeenCalledWith({ config: mocks.riskLayerConfig });
    expect(mocks.health).toHaveBeenCalledTimes(1);
    expect(mocks.safeFetch).not.toHaveBeenCalled();
  });

  it('meldet Engine ok=false als Fehler', async () => {
    mocks.health.mockResolvedValueOnce({ ok: false });

    await expect(checkSignalEngine()).resolves.toMatchObject({
      ok: false,
      error: 'Engine meldet ok=false',
    });
  });

  it('erklaert fetch failed bei Loopback-URL aus Container-Sicht', async () => {
    const err = new TypeError('fetch failed') as Error & { cause?: { code: string } };
    err.cause = { code: 'ECONNREFUSED' };
    mocks.health.mockRejectedValueOnce(err);

    const result = await checkSignalEngine();

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('RISK_LAYER_URL zeigt auf 127.0.0.1:8000'),
    });
    expect(result?.error).toContain('Docker-Container');
    expect(result?.error).toContain('http://risk-layer:8000');
  });

  it('meldet Transportfehler bei Service-DNS ohne Loopback-Hinweis', async () => {
    mocks.riskLayerConfig.url = 'http://risk-layer:8000';
    mocks.health.mockRejectedValueOnce(new TypeError('fetch failed'));

    await expect(checkSignalEngine()).resolves.toEqual({
      ok: false,
      error: 'Signal-Engine nicht erreichbar. Pruefe Container, RISK_LAYER_URL und Bearer-Token.',
    });
  });
});
