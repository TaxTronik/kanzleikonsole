import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  health: vi.fn(),
  riskLayerClient: vi.fn(),
  safeFetch: vi.fn(),
  riskLayerConfig: {
    url: 'http://127.0.0.1:8000',
    token: 'test-token',
  },
}));

vi.mock('@taxtronik/config', () => ({
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
  riskLayerConfig: mocks.riskLayerConfig,
}));

vi.mock('@taxtronik/db', () => ({
  prisma: {},
  withTenantContext: vi.fn(),
}));

vi.mock('@taxtronik/evidence', () => ({
  Rfc3161HttpAdapter: class {},
  resolveTsaUrl: vi.fn(),
}));

vi.mock('@taxtronik/risk-layer', () => ({
  RiskLayerClient: mocks.riskLayerClient,
}));

vi.mock('@/server/http/ssrf-guard', () => ({
  safeFetch: mocks.safeFetch,
}));

import { checkSignalEngine } from '../checks';

describe('checkSignalEngine', () => {
  beforeEach(() => {
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
});
