// Echte undici-Verbindung gegen einen lokalen Server: response-stream.test.ts
// ersetzt undici vollständig, der gepinnte Lookup im Agent bliebe sonst bei einem
// Bibliotheks-Update ungeprüft. Der Hostname ist im DNS nicht auflösbar; die
// Antwort kann also nur über die geprüfte, gepinnte Adresse kommen.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '127.0.0.1', family: 4 }],
}));

import { safeFetch, SsrfGuardError } from '../index';

const INTERNAL_HOST = 'service.internal.test';
const TRUSTED = { mode: 'trusted-internal' } as const;

let server: Server;
let port: number;
let lastHostHeader: string | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    lastHostHeader = req.headers.host;
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/target' });
      res.end();
      return;
    }
    res.end('pinned-body');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

afterEach(() => vi.unstubAllEnvs());

describe('safeFetch over a real undici connection', () => {
  it('connects to the pinned address and keeps the requested hostname', async () => {
    vi.stubEnv('INTERNAL_FETCH_HOSTS', INTERNAL_HOST);
    const response = await safeFetch(`http://${INTERNAL_HOST}:${port}/`, undefined, TRUSTED);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('pinned-body');
    expect(lastHostHeader).toBe(`${INTERNAL_HOST}:${port}`);
  });

  it('does not follow a redirect by default', async () => {
    vi.stubEnv('INTERNAL_FETCH_HOSTS', INTERNAL_HOST);
    await expect(
      safeFetch(`http://${INTERNAL_HOST}:${port}/redirect`, undefined, TRUSTED),
    ).rejects.toThrow();
  });

  it('refuses a public target that resolves to the local server', async () => {
    await expect(safeFetch(`http://${INTERNAL_HOST}:${port}/`)).rejects.toBeInstanceOf(
      SsrfGuardError,
    );
  });
});
