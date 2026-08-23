// =============================================================================
// Update-Manifest-Adapter
//
// Im On-Premise-Setup gibt es einen zentralen Update-Server (vom Vendor) mit
// einem signierten JSON-Manifest aller Versionen. Die App ruft das Manifest
// regelmäßig ab (Admin-UI / täglicher Job) und zeigt verfügbare Updates an.
//
// Manifest-Format v2 (JSON):
// {
//   "schemaVersion": 2,
//   "current": "1.2.3",
//   "channel": "stable" | "beta",
//   "versions": [
//     {
//       "version": "1.2.3",
//       "releasedAt": "2026-05-10T12:00:00Z",
//       "commitSha": "<40/64 lowercase hex>",
//       "artifacts": {
//         "web": { "image": "…/web:1.2.3", "digest": "sha256:…" },
//         "worker": { "image": "…/worker:1.2.3", "digest": "sha256:…" }
//       },
//       "minPreviousVersion": "1.2.0",
//       "notes": "Bugfix: …",
//       "migrationsRequired": true
//     }
//   ]
// }
//
// Signatur (zwei Transportwege, gleiche Bytes):
//   - HTTP-Header X-Manifest-Signature: ed25519:<base64(sig(body))>
//   - ODER detached unter <url>.sig (Inhalt: `ed25519:<base64>`) — statisches
//     Hosting (Forgejo-Raw, Pages, S3) kann keine Response-Header setzen;
//     die Release-Pipeline (release.yml) publiziert manifest.json +
//     manifest.json.sig (scripts/release/build-update-manifest.mjs).
//   - Public Key in env.UPDATE_PUBLIC_KEY (PEM oder raw 32-Byte base64)
//
// Nach der Signaturprüfung wird das Schema strikt validiert. Die alte
// Single-Image-Form wird auch mit gültiger Signatur abgelehnt: Ein Update darf
// nur angeboten werden, wenn Web UND Worker digest- und commitgebunden sind.
// =============================================================================

import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { z } from 'zod';
import { safeFetchPublic } from '@/server/http/ssrf-guard';

// H4: 1 MB ist großzügig für ein JSON-Manifest mit N Versionen (typisch <50 KB).
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MANIFEST_TIMEOUT_MS = 15_000;
const SEMVER_RE = /^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})$/;
const COMMIT_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const RELEASED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const IMAGE_REGISTRY_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[1-9]\d{0,4})?$/;
const IMAGE_PATH_SEGMENT_RE = /^[a-z0-9][a-z0-9._-]*$/;
const IMAGE_TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

function isTaggedImageReference(value: string): boolean {
  if (
    value.length < 3 ||
    value.length > 512 ||
    value.includes('@') ||
    value.includes('://') ||
    value.startsWith('/')
  ) {
    return false;
  }
  const lastSlash = value.lastIndexOf('/');
  const lastColon = value.lastIndexOf(':');
  if (lastSlash <= 0 || lastColon <= lastSlash + 1 || lastColon >= value.length - 1) return false;
  const name = value.slice(0, lastColon);
  const tag = value.slice(lastColon + 1);
  const [registry, ...path] = name.split('/');
  return (
    IMAGE_REGISTRY_RE.test(registry!) &&
    path.length > 0 &&
    path.every((segment) => IMAGE_PATH_SEGMENT_RE.test(segment)) &&
    IMAGE_TAG_RE.test(tag)
  );
}

function isUtcIsoTimestamp(value: string): boolean {
  if (!RELEASED_AT_RE.test(value)) return false;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return false;
  const canonical = parsed.toISOString();
  return value === canonical || value === canonical.replace('.000Z', 'Z');
}

const semverSchema = z.string().regex(SEMVER_RE);
const releaseArtifactSchema = z.strictObject({
  image: z.string().refine(isTaggedImageReference, 'getaggter Image-Repository-Pfad erwartet'),
  digest: z.string().regex(SHA256_DIGEST_RE),
});

const versionEntrySchema = z
  .strictObject({
    version: semverSchema,
    releasedAt: z.string().refine(isUtcIsoTimestamp, 'ungültiger UTC-ISO-Zeitpunkt'),
    commitSha: z.string().regex(COMMIT_SHA_RE),
    artifacts: z.strictObject({
      web: releaseArtifactSchema,
      worker: releaseArtifactSchema,
    }),
    minPreviousVersion: semverSchema.optional(),
    notes: z.string().max(100_000).optional(),
    migrationsRequired: z.boolean(),
  })
  .superRefine((entry, ctx) => {
    if (!entry.artifacts.web.image.endsWith(`:${entry.version}`)) {
      ctx.addIssue({
        code: 'custom',
        path: ['artifacts', 'web', 'image'],
        message: 'Release-Tag stimmt nicht mit version überein',
      });
    }
    if (!entry.artifacts.worker.image.endsWith(`:${entry.version}`)) {
      ctx.addIssue({
        code: 'custom',
        path: ['artifacts', 'worker', 'image'],
        message: 'Release-Tag stimmt nicht mit version überein',
      });
    }
    if (entry.artifacts.web.image === entry.artifacts.worker.image) {
      ctx.addIssue({
        code: 'custom',
        path: ['artifacts'],
        message: 'Web- und Worker-Image müssen verschieden sein',
      });
    }
    if (entry.minPreviousVersion && !semverGt(entry.version, entry.minPreviousVersion)) {
      ctx.addIssue({
        code: 'custom',
        path: ['minPreviousVersion'],
        message: 'muss kleiner als version sein',
      });
    }
  });

const updateManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(2),
    current: semverSchema,
    channel: z.enum(['stable', 'beta']),
    versions: z.array(versionEntrySchema).min(1),
  })
  .superRefine((manifest, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < manifest.versions.length; i++) {
      const entry = manifest.versions[i]!;
      if (seen.has(entry.version)) {
        ctx.addIssue({
          code: 'custom',
          path: ['versions', i, 'version'],
          message: 'Version doppelt vorhanden',
        });
      }
      seen.add(entry.version);
      if (i > 0 && !semverGt(manifest.versions[i - 1]!.version, entry.version)) {
        ctx.addIssue({
          code: 'custom',
          path: ['versions', i],
          message: 'Versionen müssen streng absteigend sortiert sein',
        });
      }
    }
    if (manifest.current !== manifest.versions[0]?.version) {
      ctx.addIssue({ code: 'custom', path: ['current'], message: 'muss versions[0] entsprechen' });
    }
  });

export type ReleaseArtifact = z.infer<typeof releaseArtifactSchema>;
export type VersionEntry = z.infer<typeof versionEntrySchema>;

export type UpdateManifest = z.infer<typeof updateManifestSchema>;

export interface CheckResult {
  ok: boolean;
  manifest?: UpdateManifest;
  hasUpdate?: boolean;
  newer?: VersionEntry[];
  warning?: string;
  error?: string;
}

/**
 * Liest das Manifest vom konfigurierten Server, verifiziert Signatur,
 * vergleicht mit aktueller installierter Version.
 */
export async function checkForUpdates(currentVersion: string): Promise<CheckResult> {
  const url = process.env['UPDATE_MANIFEST_URL'];
  if (!url) {
    return { ok: false, warning: 'UPDATE_MANIFEST_URL nicht konfiguriert.' };
  }

  // H4: SSRF-Guard + DNS-Pinning + Timeout + No-Redirect + Größen-Cap. Vorher:
  // ein redirect-Default=follow konnte auf eine interne URL hopfen, kein
  // Timeout konnte den Worker indefinit blockieren, kein Cap bedeutete bis zu
  // GB-Antwort im RAM (Ed25519-Verify erst NACH dem Read).
  let response: Response;
  try {
    response = await safeFetchPublic(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch (e) {
    return { ok: false, error: `Manifest nicht erreichbar: ${(e as Error).message}` };
  }
  if (!response.ok) {
    return { ok: false, error: `Manifest-Server: HTTP ${response.status}` };
  }
  // H4: Body-Read mit Cap. Content-Length-Vorab-Check + Streaming-Guard.
  const cl = response.headers.get('content-length');
  if (cl && Number(cl) > MAX_MANIFEST_BYTES) {
    return { ok: false, error: `Manifest zu groß: ${cl} Bytes` };
  }
  let body: string;
  try {
    const reader = response.body?.getReader();
    if (!reader) {
      return { ok: false, error: 'Manifest ohne Body.' };
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.length;
        if (total > MAX_MANIFEST_BYTES) {
          await reader.cancel().catch(() => void 0);
          return { ok: false, error: `Manifest-Body überschreitet Limit ${MAX_MANIFEST_BYTES}` };
        }
        chunks.push(value);
      }
    }
    body = Buffer.concat(chunks).toString('utf8');
  } catch (e) {
    return { ok: false, error: `Manifest-Body nicht lesbar: ${(e as Error).message}` };
  }
  let signature = response.headers.get('x-manifest-signature');
  const publicKeyB64 = process.env['UPDATE_PUBLIC_KEY'];

  let warning: string | undefined;
  if (!publicKeyB64) {
    // NEW6: In Produktion fail-closed. In Dev nur Warnung — sonst kann jemand
    // lokal nicht testen ohne Public-Key-Setup. Operatoren in Produktion
    // dürfen das nicht versehentlich ohne Signatur-Verifikation laufen lassen.
    if (process.env['NODE_ENV'] === 'production') {
      return {
        ok: false,
        error: 'UPDATE_PUBLIC_KEY nicht gesetzt — Manifest-Signatur kann nicht verifiziert werden.',
      };
    }
    warning =
      'UPDATE_PUBLIC_KEY nicht gesetzt — Manifest-Signatur nicht verifiziert (nur in Dev erlaubt)!';
  } else {
    // Statisches Hosting kann keine Header setzen → Fallback auf die detached
    // Signatur unter <url>.sig. Erst wenn BEIDE Wege fehlen, fail-closed.
    if (!signature) signature = await fetchDetachedSignature(url);
    if (!signature) {
      return {
        ok: false,
        error: 'Manifest hat keine Signatur (weder X-Manifest-Signature-Header noch <url>.sig).',
      };
    }
    const ok = verifyManifestSignature(body, signature, publicKeyB64);
    if (!ok) {
      return { ok: false, error: 'Manifest-Signatur ungültig — Update verweigert.' };
    }
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    return { ok: false, error: 'Manifest ist kein gültiges JSON.' };
  }
  const parsed = updateManifestSchema.safeParse(decoded);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.length ? `${first.path.join('.')}: ` : '';
    return {
      ok: false,
      error: `Manifest-Schema ungültig — Update verweigert${first ? ` (${path}${first.message})` : ''}.`,
    };
  }
  const manifest = parsed.data;

  const newer = manifest.versions.filter((v) => semverGt(v.version, currentVersion));
  return {
    ok: true,
    manifest,
    hasUpdate: newer.length > 0,
    newer,
    warning,
  };
}

// Signatur-Dateien sind winzig (`ed25519:` + base64(64 Bytes) ≈ 100 Zeichen);
// 4 KB lässt Luft für Whitespace, mehr ist verdächtig.
const MAX_SIG_BYTES = 4096;

/**
 * Holt die detached Signatur `<url>.sig` (Inhalt: `ed25519:<base64>`).
 * Best-effort: jeder Fehler → null, der Aufrufer entscheidet fail-closed.
 * Gleiche Guards wie das Manifest selbst (SSRF, Timeout, No-Redirect, Cap).
 */
async function fetchDetachedSignature(manifestUrl: string): Promise<string | null> {
  try {
    const res = await safeFetchPublic(`${manifestUrl}.sig`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
      redirect: 'error',
    });
    if (!res.ok) return null;
    const cl = res.headers.get('content-length');
    if (cl && Number(cl) > MAX_SIG_BYTES) return null;
    const text = (await res.text()).trim();
    if (text.length > MAX_SIG_BYTES) return null;
    return /^ed25519:[A-Za-z0-9+/=]+$/.test(text) ? text : null;
  } catch {
    return null;
  }
}

function verifyManifestSignature(
  body: string,
  signatureHeader: string,
  publicKeyB64: string,
): boolean {
  const m = signatureHeader.match(/^ed25519:(.+)$/);
  if (!m) return false;
  const sig = Buffer.from(m[1]!, 'base64');
  if (sig.length !== 64 || sig.toString('base64') !== m[1]) return false;

  // Public Key: entweder PEM oder raw 32-Byte base64
  let key;
  try {
    if (publicKeyB64.includes('BEGIN PUBLIC KEY')) {
      key = createPublicKey({ key: publicKeyB64, format: 'pem' });
    } else {
      // Raw Ed25519 → DER-Wrapper
      const raw = Buffer.from(publicKeyB64, 'base64');
      if (raw.length !== 32 || raw.toString('base64') !== publicKeyB64) return false;
      const der = Buffer.concat([
        Buffer.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]),
        raw,
      ]);
      key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    }
  } catch {
    return false;
  }

  try {
    return cryptoVerify(null, Buffer.from(body, 'utf8'), key, sig);
  } catch {
    return false;
  }
}

/** Minimaler Semver-Vergleich (X.Y.Z, ignoriert pre-release). */
function semverGt(a: string, b: string): boolean {
  const pa = a.split('.').map((s) => parseInt(s, 10) || 0);
  const pb = b.split('.').map((s) => parseInt(s, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}
