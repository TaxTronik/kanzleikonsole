import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));

import { assertPublicHost, safeFetch } from '../index';

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('INTERNAL_FETCH_HOSTS', 'n8n,seaweedfs,clamav,postgres,redis');
  mocks.lookup.mockImplementation(async (hostname: string) => {
    const address =
      hostname === 'n8n'
        ? '172.20.0.10'
        : hostname === 'n8n.example.test'
          ? '93.184.216.34'
          : '172.20.0.20';
    return [{ address, family: 4 }];
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('strict public target policy', () => {
  it.each([
    'http://seaweedfs:8333/buckets',
    'http://clamav:3310/',
    'http://postgres:5432/',
    'http://redis:6379/',
  ])('is the default and does not inherit the infrastructure allowlist for %s', async (url) => {
    await expect(assertPublicHost(url)).rejects.toMatchObject({
      reason: 'private-address',
    });
  });

  it('is also the safeFetch default and rejects before opening a connection', async () => {
    await expect(safeFetch('http://seaweedfs:8333/buckets')).rejects.toMatchObject({
      reason: 'private-address',
    });
  });

  it('does not inherit the infrastructure allowlist through the n8n policy', async () => {
    await expect(
      assertPublicHost('http://seaweedfs:8333/healthz', { mode: 'n8n', kind: 'health' }),
    ).rejects.toMatchObject({ reason: 'private-address' });
  });

  it('keeps the exact managed n8n health endpoint functional', async () => {
    await expect(
      assertPublicHost('http://n8n:5678/healthz', { mode: 'n8n', kind: 'health' }),
    ).resolves.toEqual([{ address: '172.20.0.10', family: 4 }]);
  });

  it('requires HTTPS for every external n8n target', async () => {
    await expect(
      assertPublicHost('http://n8n.example.test/webhook/workflow', {
        mode: 'n8n',
        kind: 'webhook',
      }),
    ).rejects.toMatchObject({ reason: 'forbidden-scheme' });

    await expect(
      assertPublicHost('https://n8n.example.test/webhook/workflow', {
        mode: 'n8n',
        kind: 'webhook',
      }),
    ).resolves.toEqual([{ address: '93.184.216.34', family: 4 }]);
  });
});
