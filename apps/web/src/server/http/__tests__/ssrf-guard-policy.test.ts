// K-10: Die Web-Varianten des SSRF-Guards reichen die typisierte
// HttpTargetPolicy unverändert an @taxtronik/http-utils durch (vorher über
// Signatur-Casts) — öffentlich als sicherer Default, n8n zweckgebunden.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  assertPublicHost: vi.fn(),
  safeFetch: vi.fn(),
}));

vi.mock('@taxtronik/http-utils', () => ({
  assertPublicHost: m.assertPublicHost,
  safeFetch: m.safeFetch,
  SsrfGuardError: class SsrfGuardError extends Error {},
}));

import { assertN8nUrl, assertPublicUrl, safeFetchN8n, safeFetchPublic } from '../ssrf-guard';

beforeEach(() => {
  vi.clearAllMocks();
  m.assertPublicHost.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  m.safeFetch.mockResolvedValue(new Response('ok'));
});

describe('SSRF-Guard der Web-App', () => {
  it('prüft und lädt öffentliche Ziele mit der Policy public', async () => {
    await expect(assertPublicUrl('https://feeds.example/rss')).resolves.toEqual([
      { address: '93.184.216.34', family: 4 },
    ]);
    const init = { method: 'GET' };
    await safeFetchPublic('https://updates.example/manifest.json', init);

    expect(m.assertPublicHost).toHaveBeenCalledWith('https://feeds.example/rss', {
      mode: 'public',
    });
    expect(m.safeFetch).toHaveBeenCalledWith('https://updates.example/manifest.json', init, {
      mode: 'public',
    });
  });

  it('bindet n8n-Ziele an ihren Zweck', async () => {
    await assertN8nUrl('http://n8n:5678/webhook/x', 'webhook');
    await safeFetchN8n('http://n8n:5678/healthz', 'health');

    expect(m.assertPublicHost).toHaveBeenCalledWith('http://n8n:5678/webhook/x', {
      mode: 'n8n',
      kind: 'webhook',
    });
    expect(m.safeFetch).toHaveBeenCalledWith('http://n8n:5678/healthz', undefined, {
      mode: 'n8n',
      kind: 'health',
    });
  });
});
