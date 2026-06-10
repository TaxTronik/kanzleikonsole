import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

// safeFetch mocken — der SSRF-Guard löst DNS auf und braucht echte Netz-Ziele.
const h = vi.hoisted(() => ({
  fetch: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
}));
vi.mock('@/server/http/ssrf-guard', () => ({ safeFetch: h.fetch }));

import { checkForUpdates } from '../manifest';

const MANIFEST_URL = 'https://updates.example.de/manifest.json';

// Echtes Ed25519-Paar pro Testlauf — signiert wird exakt wie in
// scripts/release/build-update-manifest.mjs (`ed25519:<base64>` über die Bytes).
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicRawB64 = publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64');

const manifest = {
  current: '1.4.0',
  channel: 'stable',
  versions: [
    {
      version: '1.4.0',
      releasedAt: '2026-06-10T12:00:00Z',
      image: 'git.example.de/taxtronik/web:1.4.0',
      imageDigest: 'sha256:' + 'a'.repeat(64),
      migrationsRequired: true,
      notes: 'Testrelease',
    },
  ],
};
const body = JSON.stringify(manifest, null, 2) + '\n';
const signature = `ed25519:${cryptoSign(null, Buffer.from(body, 'utf8'), privateKey).toString('base64')}`;

function jsonResponse(text: string, init: ResponseInit = {}): Response {
  return new Response(text, { status: 200, ...init });
}

beforeEach(() => {
  h.fetch.mockReset();
  vi.stubEnv('UPDATE_MANIFEST_URL', MANIFEST_URL);
  vi.stubEnv('UPDATE_PUBLIC_KEY', publicRawB64);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('checkForUpdates', () => {
  it('akzeptiert die Header-Signatur (X-Manifest-Signature)', async () => {
    h.fetch.mockResolvedValueOnce(
      jsonResponse(body, { headers: { 'x-manifest-signature': signature } }),
    );
    const r = await checkForUpdates('1.3.0');
    expect(r.ok).toBe(true);
    expect(r.hasUpdate).toBe(true);
    expect(r.newer?.[0]?.version).toBe('1.4.0');
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('fällt ohne Header auf die detached Signatur <url>.sig zurück (statisches Hosting)', async () => {
    h.fetch.mockImplementation(async (url: string) => {
      if (url === MANIFEST_URL) return jsonResponse(body);
      if (url === `${MANIFEST_URL}.sig`) return jsonResponse(`${signature}\n`);
      throw new Error(`unerwartete URL: ${url}`);
    });
    const r = await checkForUpdates('1.4.0');
    expect(r.ok).toBe(true);
    expect(r.hasUpdate).toBe(false); // bereits aktuell
    expect(h.fetch).toHaveBeenCalledWith(`${MANIFEST_URL}.sig`, expect.anything());
  });

  it('verweigert ein manipuliertes Manifest trotz vorhandener .sig (fail-closed)', async () => {
    const tampered = body.replace('1.4.0', '9.9.9');
    h.fetch.mockImplementation(async (url: string) => {
      if (url === MANIFEST_URL) return jsonResponse(tampered);
      return jsonResponse(signature);
    });
    const r = await checkForUpdates('1.3.0');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Signatur ungültig');
  });

  it('verweigert, wenn weder Header noch .sig existieren (fail-closed)', async () => {
    h.fetch.mockImplementation(async (url: string) => {
      if (url === MANIFEST_URL) return jsonResponse(body);
      return new Response('not found', { status: 404 });
    });
    const r = await checkForUpdates('1.3.0');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('keine Signatur');
  });

  it('verweigert eine .sig mit fremdem Schlüssel', async () => {
    const { privateKey: wrongKey } = generateKeyPairSync('ed25519');
    const wrongSig = `ed25519:${cryptoSign(null, Buffer.from(body, 'utf8'), wrongKey).toString('base64')}`;
    h.fetch.mockImplementation(async (url: string) => {
      if (url === MANIFEST_URL) return jsonResponse(body);
      return jsonResponse(wrongSig);
    });
    const r = await checkForUpdates('1.3.0');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Signatur ungültig');
  });
});
