import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { Buffer } from 'node:buffer';

export const UPDATE_MANIFEST_SCHEMA_VERSION = 2;
export const SEMVER_RE = /^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})$/;
export const COMMIT_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

const RELEASED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const IMAGE_REGISTRY_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[1-9]\d{0,4})?$/;
const IMAGE_PATH_SEGMENT_RE = /^[a-z0-9][a-z0-9._-]*$/;
const IMAGE_TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

export function compareSemver(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

export function isTaggedImageReference(value) {
  if (typeof value !== 'string' || value.length < 3 || value.length > 512) return false;
  if (value.includes('@') || value.includes('://') || value.startsWith('/')) return false;
  const lastSlash = value.lastIndexOf('/');
  const lastColon = value.lastIndexOf(':');
  if (lastSlash <= 0 || lastColon <= lastSlash + 1 || lastColon >= value.length - 1) return false;
  const name = value.slice(0, lastColon);
  const tag = value.slice(lastColon + 1);
  const [registry, ...path] = name.split('/');
  return (
    IMAGE_REGISTRY_RE.test(registry) &&
    path.length > 0 &&
    path.every((segment) => IMAGE_PATH_SEGMENT_RE.test(segment)) &&
    IMAGE_TAG_RE.test(tag)
  );
}

function isUtcIsoTimestamp(value) {
  if (typeof value !== 'string' || !RELEASED_AT_RE.test(value)) return false;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return false;
  const canonical = parsed.toISOString();
  return value === canonical || value === canonical.replace('.000Z', 'Z');
}

function validateArtifact(value, path, version, errors) {
  if (!isRecord(value)) {
    errors.push(`${path} muss ein Objekt sein`);
    return;
  }
  if (!hasOnlyKeys(value, new Set(['image', 'digest']))) {
    errors.push(`${path} enthält unbekannte Felder`);
  }
  if (!isTaggedImageReference(value.image)) {
    errors.push(`${path}.image muss ein getaggter Image-Repository-Pfad sein`);
  } else if (!value.image.endsWith(`:${version}`)) {
    errors.push(`${path}.image muss auf den Release-Tag :${version} enden`);
  }
  if (typeof value.digest !== 'string' || !SHA256_DIGEST_RE.test(value.digest)) {
    errors.push(`${path}.digest muss sha256:<hex64> sein`);
  }
}

function validateVersionEntry(value, path, errors) {
  if (!isRecord(value)) {
    errors.push(`${path} muss ein Objekt sein`);
    return;
  }
  const allowed = new Set([
    'version',
    'releasedAt',
    'commitSha',
    'artifacts',
    'minPreviousVersion',
    'notes',
    'migrationsRequired',
  ]);
  if (!hasOnlyKeys(value, allowed)) errors.push(`${path} enthält unbekannte Felder`);

  if (typeof value.version !== 'string' || !SEMVER_RE.test(value.version)) {
    errors.push(`${path}.version muss X.Y.Z sein`);
  }
  if (!isUtcIsoTimestamp(value.releasedAt)) {
    errors.push(`${path}.releasedAt muss ein UTC-ISO-Zeitpunkt sein`);
  }
  if (typeof value.commitSha !== 'string' || !COMMIT_SHA_RE.test(value.commitSha)) {
    errors.push(
      `${path}.commitSha muss ein kleingeschriebener Git-SHA (40 oder 64 Hex-Zeichen) sein`,
    );
  }
  if (typeof value.migrationsRequired !== 'boolean') {
    errors.push(`${path}.migrationsRequired muss boolean sein`);
  }
  if (
    value.minPreviousVersion !== undefined &&
    (typeof value.minPreviousVersion !== 'string' || !SEMVER_RE.test(value.minPreviousVersion))
  ) {
    errors.push(`${path}.minPreviousVersion muss X.Y.Z sein`);
  } else if (
    typeof value.version === 'string' &&
    SEMVER_RE.test(value.version) &&
    typeof value.minPreviousVersion === 'string' &&
    SEMVER_RE.test(value.minPreviousVersion) &&
    compareSemver(value.minPreviousVersion, value.version) >= 0
  ) {
    errors.push(`${path}.minPreviousVersion muss kleiner als version sein`);
  }
  if (
    value.notes !== undefined &&
    (typeof value.notes !== 'string' || value.notes.length > 100_000)
  ) {
    errors.push(`${path}.notes muss ein String mit höchstens 100000 Zeichen sein`);
  }

  if (!isRecord(value.artifacts)) {
    errors.push(`${path}.artifacts muss ein Objekt sein`);
    return;
  }
  if (!hasOnlyKeys(value.artifacts, new Set(['web', 'worker']))) {
    errors.push(`${path}.artifacts enthält unbekannte Felder`);
  }
  if (!Object.hasOwn(value.artifacts, 'web') || !Object.hasOwn(value.artifacts, 'worker')) {
    errors.push(`${path}.artifacts muss web und worker enthalten`);
  }
  validateArtifact(value.artifacts.web, `${path}.artifacts.web`, value.version, errors);
  validateArtifact(value.artifacts.worker, `${path}.artifacts.worker`, value.version, errors);
  if (
    isRecord(value.artifacts.web) &&
    isRecord(value.artifacts.worker) &&
    value.artifacts.web.image === value.artifacts.worker.image
  ) {
    errors.push(`${path}: Web- und Worker-Image müssen verschieden sein`);
  }
}

/**
 * Validiert ausschließlich Manifest-Schema v2. Unbekannte Felder sowie die
 * frühere Single-Image-Form werden bewusst abgelehnt, damit eine gültige
 * Signatur nie über unvollständige Release-Artefakte hinwegtäuscht.
 */
export function validateUpdateManifestV2(value) {
  const errors = [];
  if (!isRecord(value)) return ['Manifest muss ein Objekt sein'];
  if (!hasOnlyKeys(value, new Set(['schemaVersion', 'current', 'channel', 'versions']))) {
    errors.push('Manifest enthält unbekannte Felder');
  }
  if (value.schemaVersion !== UPDATE_MANIFEST_SCHEMA_VERSION) {
    errors.push(`schemaVersion muss ${UPDATE_MANIFEST_SCHEMA_VERSION} sein`);
  }
  if (typeof value.current !== 'string' || !SEMVER_RE.test(value.current)) {
    errors.push('current muss X.Y.Z sein');
  }
  if (value.channel !== 'stable' && value.channel !== 'beta') {
    errors.push('channel muss stable oder beta sein');
  }
  if (!Array.isArray(value.versions) || value.versions.length === 0) {
    errors.push('versions muss mindestens einen Eintrag enthalten');
    return errors;
  }

  const seen = new Set();
  for (let i = 0; i < value.versions.length; i++) {
    const entry = value.versions[i];
    validateVersionEntry(entry, `versions[${i}]`, errors);
    if (isRecord(entry) && typeof entry.version === 'string' && SEMVER_RE.test(entry.version)) {
      if (seen.has(entry.version)) errors.push(`versions enthält ${entry.version} mehrfach`);
      seen.add(entry.version);
      if (i > 0) {
        const previous = value.versions[i - 1];
        if (
          isRecord(previous) &&
          typeof previous.version === 'string' &&
          SEMVER_RE.test(previous.version) &&
          compareSemver(previous.version, entry.version) <= 0
        ) {
          errors.push('versions muss streng absteigend nach Version sortiert sein');
        }
      }
    }
  }
  if (isRecord(value.versions[0]) && value.current !== value.versions[0].version) {
    errors.push('current muss der höchsten Version (versions[0]) entsprechen');
  }
  return errors;
}

/** Erkennt nur die bekannte, strikt geformte v1-Single-Image-Struktur. */
export function isLegacySingleImageManifest(value) {
  if (!isRecord(value) || Object.hasOwn(value, 'schemaVersion')) return false;
  if (!hasOnlyKeys(value, new Set(['current', 'channel', 'versions']))) return false;
  if (!SEMVER_RE.test(value.current ?? '') || !['stable', 'beta'].includes(value.channel))
    return false;
  if (!Array.isArray(value.versions) || value.versions.length === 0) return false;
  const allowed = new Set([
    'version',
    'releasedAt',
    'image',
    'imageDigest',
    'minPreviousVersion',
    'notes',
    'migrationsRequired',
  ]);
  return value.versions.every(
    (entry) =>
      isRecord(entry) &&
      hasOnlyKeys(entry, allowed) &&
      SEMVER_RE.test(entry.version ?? '') &&
      typeof entry.releasedAt === 'string' &&
      isTaggedImageReference(entry.image) &&
      SHA256_DIGEST_RE.test(entry.imageDigest ?? '') &&
      typeof entry.migrationsRequired === 'boolean',
  );
}

export function verifyManifestSignature(body, signatureValue, publicKeyValue) {
  const match = /^ed25519:([A-Za-z0-9+/]+={0,2})$/.exec(signatureValue.trim());
  if (!match) return false;
  const signature = Buffer.from(match[1], 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== match[1]) return false;

  let key;
  try {
    if (publicKeyValue.includes('BEGIN PUBLIC KEY')) {
      key = createPublicKey({ key: publicKeyValue, format: 'pem' });
    } else {
      const raw = Buffer.from(publicKeyValue, 'base64');
      if (raw.length !== 32 || raw.toString('base64') !== publicKeyValue) return false;
      const der = Buffer.concat([
        Buffer.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]),
        raw,
      ]);
      key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    }
    return key.asymmetricKeyType === 'ed25519' && cryptoVerify(null, body, key, signature);
  } catch {
    return false;
  }
}
