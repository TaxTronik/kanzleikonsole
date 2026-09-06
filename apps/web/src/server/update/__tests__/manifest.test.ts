// Fachkatalog: ASSURANCE-RELEASE-EVIDENCE-001.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// safeFetch mocken — der SSRF-Guard löst DNS auf und braucht echte Netz-Ziele.
const h = vi.hoisted(() => ({
  fetch:
    vi.fn<
      (
        url: string,
        init?: RequestInit,
        policy?: { mode: 'trusted-internal' | 'public' },
      ) => Promise<Response>
    >(),
}));
vi.mock('@/server/http/ssrf-guard', () => ({ safeFetchPublic: h.fetch }));

import { checkForUpdates } from '../manifest';

const MANIFEST_URL = 'https://updates.example.de/manifest.json';

// Echtes Ed25519-Paar pro Testlauf — signiert wird exakt wie in
// scripts/release/build-update-manifest.mjs (`ed25519:<base64>` über die Bytes).
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicRawB64 = publicKey
  .export({ type: 'spki', format: 'der' })
  .subarray(12)
  .toString('base64');
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const manifest = {
  schemaVersion: 2,
  current: '1.4.0',
  channel: 'stable',
  versions: [
    {
      version: '1.4.0',
      releasedAt: '2026-06-10T12:00:00Z',
      commitSha: 'c'.repeat(40),
      artifacts: {
        web: {
          image: 'git.example.de/taxtronik/web:1.4.0',
          digest: 'sha256:' + 'a'.repeat(64),
        },
        worker: {
          image: 'git.example.de/taxtronik/worker:1.4.0',
          digest: 'sha256:' + 'b'.repeat(64),
        },
      },
      migrationsRequired: true,
      notes: 'Testrelease',
    },
  ],
};
const body = JSON.stringify(manifest, null, 2) + '\n';
const signature = `ed25519:${cryptoSign(null, Buffer.from(body, 'utf8'), privateKey).toString('base64')}`;

function signManifest(value: unknown): { body: string; signature: string } {
  const signedBody = JSON.stringify(value, null, 2) + '\n';
  return {
    body: signedBody,
    signature: `ed25519:${cryptoSign(null, Buffer.from(signedBody, 'utf8'), privateKey).toString('base64')}`,
  };
}

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
    expect(r.newer?.[0]?.artifacts.worker.digest).toBe('sha256:' + 'b'.repeat(64));
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.fetch).toHaveBeenCalledWith(MANIFEST_URL, expect.anything());
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

  it.each([undefined, '1'])(
    'bricht eine übergroße Signatur beim Lesen ab (Content-Length: %s)',
    async (declaredLength) => {
      let produced = 0;
      const cancel = vi.fn();
      const streamed = new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(1024).fill(65));
            if (++produced === 64) controller.close();
          },
          cancel,
        }),
        { headers: declaredLength ? { 'content-length': declaredLength } : {} },
      );
      h.fetch.mockResolvedValueOnce(jsonResponse(body)).mockResolvedValueOnce(streamed);

      expect((await checkForUpdates('1.3.0')).ok).toBe(false);
      expect(produced).toBeLessThanOrEqual(6); // 4 KiB + overflow chunk + source prefetch
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it('begrenzt Signaturen in Bytes vor UTF-8-Dekodierung und Whitespace-Entfernung', async () => {
    const paddedSignature = signature + '\u00a0'.repeat(2048);
    expect(paddedSignature.length).toBeLessThan(4096);
    expect(Buffer.byteLength(paddedSignature)).toBeGreaterThan(4096);
    h.fetch
      .mockResolvedValueOnce(jsonResponse(body))
      .mockResolvedValueOnce(jsonResponse(paddedSignature));
    const result = await checkForUpdates('1.3.0');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('keine Signatur');
  });

  it('akzeptiert eine gültige Signatur exakt an der bisherigen 4096-Byte-Grenze', async () => {
    const paddedSignature = signature.padEnd(4096, ' ');
    h.fetch
      .mockResolvedValueOnce(jsonResponse(body))
      .mockResolvedValueOnce(jsonResponse(paddedSignature));
    expect((await checkForUpdates('1.3.0')).ok).toBe(true);
  });

  it.each([
    ['manifest', 'status', 503, undefined],
    ['manifest', 'content-length', 200, String(1024 * 1024 + 1)],
    ['signature', 'status', 503, undefined],
    ['signature', 'content-length', 200, '4097'],
  ] as const)(
    'verwirft den %s-Body sofort bei %s-Ablehnung',
    async (kind, _reason, status, length) => {
      const cancel = vi.fn();
      const response = new Response(new ReadableStream({ cancel }), {
        status,
        headers: length ? { 'content-length': length } : {},
      });
      if (kind === 'signature') h.fetch.mockResolvedValueOnce(jsonResponse(body));
      h.fetch.mockResolvedValueOnce(response);

      const result = await checkForUpdates('1.3.0');
      const cancelledByAdapter = cancel.mock.calls.length;
      await response.body!.cancel(); // Clean up even against the unfixed adapter.
      expect(result.ok).toBe(false);
      expect(cancelledByAdapter).toBe(1);
    },
  );

  it('behält die 1-MiB-Manifestgrenze bei falschem Content-Length beim Streaming bei', async () => {
    const cancel = vi.fn();
    let produced = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(256 * 1024));
          if (++produced === 16) controller.close();
        },
        cancel,
      }),
      { headers: { 'content-length': '1' } },
    );
    h.fetch.mockResolvedValueOnce(response);
    const result = await checkForUpdates('1.3.0');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Manifest-Body überschreitet Limit');
    expect(cancel).toHaveBeenCalledOnce();
    expect(produced).toBeLessThanOrEqual(6);
    expect(h.fetch).toHaveBeenCalledOnce();
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

  it('verweigert die alte Single-Image-Form auch mit gültiger Signatur', async () => {
    const legacy = signManifest({
      current: '1.4.0',
      channel: 'stable',
      versions: [
        {
          version: '1.4.0',
          releasedAt: '2026-06-10T12:00:00Z',
          image: 'git.example.de/taxtronik/web:1.4.0',
          imageDigest: 'sha256:' + 'a'.repeat(64),
          migrationsRequired: true,
        },
      ],
    });
    h.fetch.mockResolvedValueOnce(
      jsonResponse(legacy.body, { headers: { 'x-manifest-signature': legacy.signature } }),
    );

    const r = await checkForUpdates('1.3.0');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Manifest-Schema ungültig');
  });

  it.each([
    [
      'fehlenden Worker',
      () => {
        const value = structuredClone(manifest) as unknown as {
          versions: Array<{ artifacts: { worker?: unknown } }>;
        };
        delete value.versions[0]!.artifacts.worker;
        return value;
      },
    ],
    [
      'ungültigen Digest',
      () => {
        const value = structuredClone(manifest);
        value.versions[0]!.artifacts.worker.digest = 'sha512:' + 'b'.repeat(64);
        return value;
      },
    ],
    [
      'ungültigen Commit-SHA',
      () => {
        const value = structuredClone(manifest);
        value.versions[0]!.commitSha = 'deadbeef';
        return value;
      },
    ],
    [
      'unbekannte Felder',
      () => ({ ...structuredClone(manifest), unsignedDownloadUrl: 'https://evil.example/image' }),
    ],
    ['inkonsistente current-Version', () => ({ ...structuredClone(manifest), current: '1.3.9' })],
  ])('verweigert %s trotz gültiger Signatur', async (_label, mutate) => {
    const invalid = signManifest(mutate());
    h.fetch.mockResolvedValueOnce(
      jsonResponse(invalid.body, { headers: { 'x-manifest-signature': invalid.signature } }),
    );
    const r = await checkForUpdates('1.3.0');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Manifest-Schema ungültig');
  });
});

describe('build-update-manifest.mjs', () => {
  const buildScript = fileURLToPath(
    new URL('../../../../../../scripts/release/build-update-manifest.mjs', import.meta.url),
  );
  const verifyScript = fileURLToPath(
    new URL('../../../../../../scripts/release/verify-update-manifest.mjs', import.meta.url),
  );
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'taxtronik-manifest-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function buildArgs(overrides: Record<string, string> = {}): string[] {
    const values = {
      version: '2.0.0',
      'commit-sha': 'd'.repeat(40),
      'web-image': 'registry.example/taxtronik/web:2.0.0',
      'web-image-digest': 'sha256:' + '1'.repeat(64),
      'worker-image': 'registry.example/taxtronik/worker:2.0.0',
      'worker-image-digest': 'sha256:' + '2'.repeat(64),
      'migrations-required': 'true',
      'out-dir': dir,
      ...overrides,
    };
    return Object.entries(values).flatMap(([key, value]) => [`--${key}`, value]);
  }

  function runBuilder(args: string[]): string {
    return execFileSync(process.execPath, [buildScript, ...args], {
      encoding: 'utf8',
      env: { ...process.env, UPDATE_MANIFEST_PRIVATE_KEY: privatePem },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  it('bindet Commit sowie Web-/Worker-Digest in die signierten Manifest-Bytes', () => {
    runBuilder(buildArgs());
    const manifestBytes = readFileSync(join(dir, 'manifest.json'));
    const generated = JSON.parse(manifestBytes.toString('utf8'));
    const generatedSignature = readFileSync(join(dir, 'manifest.json.sig'), 'utf8');
    const signatureBytes = Buffer.from(generatedSignature.slice('ed25519:'.length), 'base64');

    expect(generated).toMatchObject({
      schemaVersion: 2,
      current: '2.0.0',
      versions: [
        {
          commitSha: 'd'.repeat(40),
          artifacts: {
            web: { digest: 'sha256:' + '1'.repeat(64) },
            worker: { digest: 'sha256:' + '2'.repeat(64) },
          },
        },
      ],
    });
    expect(cryptoVerify(null, manifestBytes, publicKey, signatureBytes)).toBe(true);

    const verifiedContract = JSON.parse(
      execFileSync(
        process.execPath,
        [
          verifyScript,
          '--manifest',
          join(dir, 'manifest.json'),
          '--signature',
          join(dir, 'manifest.json.sig'),
          '--version',
          '2.0.0',
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, UPDATE_PUBLIC_KEY: publicRawB64 },
        },
      ),
    );
    expect(verifiedContract.web.pinnedImage).toBe(
      `registry.example/taxtronik/web:2.0.0@sha256:${'1'.repeat(64)}`,
    );
    expect(verifiedContract.worker.pinnedImage).toBe(
      `registry.example/taxtronik/worker:2.0.0@sha256:${'2'.repeat(64)}`,
    );
  });

  it('migriert ein strikt gültiges v1-Manifest ohne unsichere Single-Image-Historie', () => {
    const legacyPath = join(dir, 'legacy.json');
    const legacy = signManifest({
      current: '1.9.0',
      channel: 'stable',
      versions: [
        {
          version: '1.9.0',
          releasedAt: '2026-06-01T00:00:00Z',
          image: 'registry.example/taxtronik/web:1.9.0',
          imageDigest: 'sha256:' + '9'.repeat(64),
          migrationsRequired: false,
        },
      ],
    });
    writeFileSync(legacyPath, legacy.body);
    writeFileSync(`${legacyPath}.sig`, legacy.signature);

    runBuilder(buildArgs({ in: legacyPath }));
    const generated = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    expect(generated.schemaVersion).toBe(2);
    expect(generated.versions.map((entry: { version: string }) => entry.version)).toEqual([
      '2.0.0',
    ]);
  });

  it('macht Release-Einträge unveränderlich, bleibt aber bei identischem Re-Run byte-idempotent', () => {
    runBuilder(buildArgs());
    const manifestPath = join(dir, 'manifest.json');
    const before = readFileSync(manifestPath, 'utf8');

    runBuilder(buildArgs({ in: manifestPath }));
    expect(readFileSync(manifestPath, 'utf8')).toBe(before);

    expect(() =>
      runBuilder(
        buildArgs({
          in: manifestPath,
          'worker-image-digest': 'sha256:' + '3'.repeat(64),
        }),
      ),
    ).toThrow();
  });

  it('signiert ein manipuliertes bestehendes Manifest nicht erneut', () => {
    runBuilder(buildArgs());
    const manifestPath = join(dir, 'manifest.json');
    const tampered = readFileSync(manifestPath, 'utf8').replace('"stable"', '"beta"');
    writeFileSync(manifestPath, tampered);

    expect(() => runBuilder(buildArgs({ in: manifestPath }))).toThrow();
  });
});
