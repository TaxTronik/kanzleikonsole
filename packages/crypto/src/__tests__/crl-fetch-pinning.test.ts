// Fachkatalog: ACCESS-TENANT-RLS-001
// =============================================================================
// T-02 (SSRF, DNS-Rebinding): fetchCrl löst den Host genau einmal auf und gibt
// dem Verbindungsaufbau nur die geprüften Adressen. node:http/node:https sind
// hier Attrappen, die den übergebenen lookup so aufrufen wie Node beim
// Verbinden (Happy Eyeballs: `all: true`); eine echte Verbindung zu einer
// öffentlichen Adresse entsteht nicht. Die echte Verbindung zur gepinnten
// Adresse belegt crl-fetch.test.ts gegen einen lokalen Server.
// =============================================================================

import type { LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Connection = {
  module: 'http' | 'https';
  url: URL;
  options: { lookup: LookupFunction; agent?: unknown; signal?: AbortSignal; timeout?: number };
  connectedTo: unknown;
};

const h = vi.hoisted(() => {
  const connections: Connection[] = [];
  /** Wie http.request: verbindet beim end() über den übergebenen lookup. */
  const request =
    (module: 'http' | 'https') =>
    (url: URL, options: Connection['options'], onResponse: (response: unknown) => void) => {
      const listeners = new Map<string, (error: unknown) => void>();
      const connection: Connection = { module, url, options, connectedTo: undefined };
      connections.push(connection);
      return {
        on(event: string, listener: (error: unknown) => void) {
          listeners.set(event, listener);
          return this;
        },
        destroy: () => undefined,
        end: async () => {
          const { PassThrough } = await import('node:stream');
          const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
          options.lookup(host, { all: true }, (error, addresses) => {
            if (error) {
              listeners.get('error')?.(error);
              return;
            }
            connection.connectedTo = addresses;
            const body = Object.assign(new PassThrough(), {
              statusCode: 200,
              statusMessage: 'OK',
              headers: { 'content-length': '3' },
            });
            onResponse(body);
            body.end(Buffer.from([1, 2, 3]));
          });
        },
      };
    };
  return { connections, request };
});

vi.mock('node:http', () => ({ default: { request: vi.fn(h.request('http')) } }));
vi.mock('node:https', () => ({ default: { request: vi.fn(h.request('https')) } }));

import { fetchCrl } from '../crl-fetch';

const PUBLIC: LookupAddress = { address: '93.184.215.14', family: 4 };
const PUBLIC_V6: LookupAddress = { address: '2606:2800:21f:cb07:6820:80da:af6b:8b2c', family: 6 };

function lookupOnce(
  lookup: LookupFunction,
  hostname: string,
  options: Parameters<LookupFunction>[1],
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    lookup(hostname, options, (error, address, family) =>
      error ? reject(error) : resolve(options.all ? address : [address, family]),
    );
  });
}

beforeEach(() => {
  h.connections.splice(0);
});

describe('fetchCrl: eine Auflösung, Verbindung nur zu den geprüften Adressen', () => {
  it('verbindet trotz geänderter zweiter DNS-Antwort mit der zuerst geprüften Adresse', async () => {
    // Rebinding: erst öffentlich, danach Loopback.
    const resolve = vi
      .fn()
      .mockResolvedValueOnce([PUBLIC])
      .mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);

    const response = await fetchCrl(
      'http://crl.example.com/root.crl',
      { redirect: 'error' },
      resolve,
    );

    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(resolve).toHaveBeenCalledExactlyOnceWith('crl.example.com');
    expect(h.connections).toHaveLength(1);
    expect(h.connections[0]!.connectedTo).toEqual([PUBLIC]);

    // Auch spätere Lookups des Verbindungsaufbaus fragen kein DNS mehr.
    const { lookup } = h.connections[0]!.options;
    await expect(lookupOnce(lookup, 'crl.example.com', { all: true })).resolves.toEqual([PUBLIC]);
    await expect(lookupOnce(lookup, 'crl.example.com', {})).resolves.toEqual([PUBLIC.address, 4]);
    expect(resolve).toHaveBeenCalledOnce();
  });

  it('liefert je Adressfamilie nur geprüfte Adressen und keine für andere Hosts', async () => {
    const resolve = vi.fn(async () => [PUBLIC, PUBLIC_V6]);
    await fetchCrl('http://crl.example.com/root.crl', { redirect: 'error' }, resolve);
    const { lookup } = h.connections[0]!.options;

    await expect(lookupOnce(lookup, 'crl.example.com', { family: 6 })).resolves.toEqual([
      PUBLIC_V6.address,
      6,
    ]);
    await expect(lookupOnce(lookup, 'crl.example.com', { family: 4, all: true })).resolves.toEqual([
      PUBLIC,
    ]);
    await expect(lookupOnce(lookup, 'intern.example.com', { all: true })).rejects.toMatchObject({
      code: 'ENOTFOUND',
    });
  });

  it('weist eine Antwort ab, die nur in einer Familie fehlt', async () => {
    await fetchCrl('http://crl.example.com/root.crl', { redirect: 'error' }, async () => [PUBLIC]);
    const { lookup } = h.connections[0]!.options;
    await expect(lookupOnce(lookup, 'crl.example.com', { family: 6 })).rejects.toMatchObject({
      code: 'ENOTFOUND',
    });
  });

  it('nutzt für https das TLS-Modul mit dem Hostnamen als Ziel, ohne Socket-Pool', async () => {
    const controller = new AbortController();
    await fetchCrl(
      'https://crl.example.com/root.crl',
      { redirect: 'error', signal: controller.signal },
      async () => [PUBLIC],
    );

    const [connection] = h.connections;
    expect(connection!.module).toBe('https');
    // Hostname bleibt Ziel von SNI und Zertifikatsprüfung; nur die Adresse ist gepinnt.
    expect(connection!.url.hostname).toBe('crl.example.com');
    expect(connection!.options).toMatchObject({
      agent: false,
      signal: controller.signal,
      timeout: 300_000,
    });
    expect(connection!.options).not.toHaveProperty('servername');
    expect(connection!.connectedTo).toEqual([PUBLIC]);
  });
});
