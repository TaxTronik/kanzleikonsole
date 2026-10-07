// =============================================================================
// F-12: eine TSA-Auswahl für Stempel und Prüfung (tsa-port.ts).
// Fachkatalog: AUDIT-RFC3161-ANCHOR-001, AUDIT-ARCHIVE-001
//
// Auflösung Tenant-Einstellung → ENV → GlobalSign-Default; Stempeln prüft die
// URL per SSRF-/DNS-Check, die Prüfung braucht in Produktion kein Netz.
// =============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>,
  readSetting: vi.fn(),
  assertPublicHost: vi.fn(),
  warn: vi.fn(),
  systemTx: { systemTx: true },
  contexts: [] as string[],
}));

vi.mock('@taxtronik/config', () => ({ env: h.env }));
vi.mock('@taxtronik/db/tenant-settings', () => ({ readTenantSettingValue: h.readSetting }));
// S-01: gelesen im SYSTEM-Kontext des Tenants (tsa-port-db.test.ts: App-Rolle).
vi.mock('@taxtronik/db', () => ({
  withSystemContext: async (tenantId: string, fn: (tx: unknown) => unknown) => {
    h.contexts.push(tenantId);
    return fn(h.systemTx);
  },
}));
vi.mock('../http/ssrf-guard', () => ({ assertPublicHost: h.assertPublicHost }));
vi.mock('../logger', () => ({ log: { warn: h.warn, info: vi.fn(), error: vi.fn() } }));
vi.mock('@taxtronik/evidence', async () => {
  const providers =
    await vi.importActual<typeof import('@taxtronik/evidence')>('@taxtronik/evidence');
  class LocalTimestampAdapter {
    readonly mode = 'local';
  }
  return {
    LocalTimestampAdapter,
    resolveTsaUrl: providers.resolveTsaUrl,
    createRfc3161Adapter: (url: string) => ({ mode: 'rfc3161', url }),
  };
});

import { resolveTsa, selectTsaUrl, timestampPortFor } from '../tsa-port';

const GLOBALSIGN = 'http://timestamp.globalsign.com/tsa/r6advanced1';
const TENANT = 'tenant-1';

beforeEach(() => {
  vi.resetAllMocks();
  h.contexts.length = 0;
  for (const key of Object.keys(h.env)) delete h.env[key];
  h.readSetting.mockResolvedValue(undefined);
  h.assertPublicHost.mockResolvedValue([]);
});

describe('selectTsaUrl: Tenant → ENV → GlobalSign-Default', () => {
  it('bevorzugt das Tenant-Preset und liest im SYSTEM-Kontext des Tenants', async () => {
    h.readSetting.mockResolvedValue({ providerId: 'freetsa', customUrl: '' });
    h.env['TIMESTAMP_AUTHORITY_URL'] = 'https://env.example/tsr';

    expect(await selectTsaUrl(TENANT)).toEqual({
      url: 'https://freetsa.org/tsr',
      source: 'tenant',
    });
    expect(h.readSetting).toHaveBeenCalledWith(h.systemTx, TENANT, 'evidence.tsa');
    expect(h.contexts).toEqual([TENANT]);
  });

  it('nimmt eine eigene Tenant-URL nur mit providerId custom', async () => {
    h.readSetting.mockResolvedValue({
      providerId: 'custom',
      customUrl: ' https://own.example/tsr ',
    });
    expect(await selectTsaUrl(TENANT)).toEqual({
      url: 'https://own.example/tsr',
      source: 'tenant',
    });
  });

  it.each([
    ['ohne Tenant-Einstellung', undefined],
    ['mit leerer Auswahl', { providerId: '', customUrl: '' }],
    ['mit unbekanntem Preset', { providerId: 'gibt-es-nicht' }],
    ['mit custom ohne URL', { providerId: 'custom', customUrl: '' }],
  ])('fällt %s auf ENV zurück', async (_case, stored) => {
    h.readSetting.mockResolvedValue(stored);
    h.env['TIMESTAMP_AUTHORITY_URL'] = ' https://env.example/tsr ';

    expect(await selectTsaUrl(TENANT)).toEqual({ url: 'https://env.example/tsr', source: 'env' });
  });

  it('ohne Tenant und ENV gilt der verifizierte GlobalSign-Default', async () => {
    expect(await selectTsaUrl(TENANT)).toEqual({ url: GLOBALSIGN, source: 'default' });
  });
});

describe("resolveTsa(…, 'stamp')", () => {
  it('prüft die URL vor dem Abruf und liefert den RFC-3161-Adapter', async () => {
    const tsa = await resolveTsa(TENANT, 'stamp');

    expect(h.assertPublicHost).toHaveBeenCalledWith(GLOBALSIGN, { mode: 'public' });
    expect(tsa).toEqual({
      port: { mode: 'rfc3161', url: GLOBALSIGN },
      url: GLOBALSIGN,
      source: 'default',
    });
  });

  it('fällt außerhalb der Produktion bei nicht auflösbarer TSA auf Self-Timestamp zurück', async () => {
    h.assertPublicHost.mockRejectedValue(new Error('getaddrinfo EAI_AGAIN'));

    const tsa = await resolveTsa(TENANT, 'stamp');

    expect(tsa.port.mode).toBe('local');
    expect(tsa.url).toBe(GLOBALSIGN);
    expect(h.warn).toHaveBeenCalled();
  });

  it('wirft in Produktion statt still lokal zu stempeln', async () => {
    h.env['NODE_ENV'] = 'production';
    h.assertPublicHost.mockRejectedValue(new Error('getaddrinfo EAI_AGAIN'));

    await expect(resolveTsa(TENANT, 'stamp')).rejects.toThrow('EAI_AGAIN');
  });

  it('ist die Voreinstellung von timestampPortFor', async () => {
    expect(await timestampPortFor(TENANT)).toEqual({ mode: 'rfc3161', url: GLOBALSIGN });
    expect(h.assertPublicHost).toHaveBeenCalledTimes(1);
  });
});

describe("resolveTsa(…, 'verify')", () => {
  it('prüft in Produktion ohne Netz: kein DNS-/SSRF-Aufruf, auch bei DNS-Ausfall', async () => {
    h.env['NODE_ENV'] = 'production';
    h.readSetting.mockResolvedValue({ providerId: 'custom', customUrl: 'https://own.example/tsr' });
    h.assertPublicHost.mockRejectedValue(new Error('getaddrinfo EAI_AGAIN own.example'));

    const tsa = await resolveTsa(TENANT, 'verify');

    expect(h.assertPublicHost).not.toHaveBeenCalled();
    expect(tsa).toEqual({
      port: { mode: 'rfc3161', url: 'https://own.example/tsr' },
      url: 'https://own.example/tsr',
      source: 'tenant',
    });
    expect(await timestampPortFor(TENANT, 'verify')).toEqual(tsa.port);
  });

  it('bleibt außerhalb der Produktion an die Stempel-Entscheidung gekoppelt', async () => {
    h.assertPublicHost.mockRejectedValue(new Error('resolves to private IP'));

    expect((await resolveTsa(TENANT, 'verify')).port.mode).toBe('local');
  });
});
