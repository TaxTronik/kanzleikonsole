// Verifiziert ein lokales Update-Manifest samt detached Ed25519-Signatur und
// gibt den strikt validierten, digest-gepinnten Release-Vertrag aus.
//
// UPDATE_PUBLIC_KEY=<PEM|raw-base64> node scripts/release/verify-update-manifest.mjs \
//   --manifest manifest.json --signature manifest.json.sig --version 0.2.0 \
//   [--format json|env]

import { readFileSync } from 'node:fs';
import {
  SEMVER_RE,
  validateUpdateManifestV2,
  verifyManifestSignature,
} from './update-manifest-format.mjs';

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SIGNATURE_BYTES = 4096;

function die(message) {
  process.stderr.write(`FEHLER: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const allowed = new Set(['manifest', 'signature', 'version', 'format']);
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) die(`Unerwartetes Argument: ${arg}`);
    const key = arg.slice(2);
    if (!allowed.has(key)) die(`Unbekannte Option: --${key}`);
    if (Object.hasOwn(result, key)) die(`Option --${key} wurde mehrfach angegeben`);
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) die(`Wert für --${key} fehlt`);
    result[key] = argv[++i];
  }
  return result;
}

function readBounded(path, limit, label) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    die(`${label} nicht lesbar: ${error.message}`);
  }
  if (bytes.length > limit) die(`${label} überschreitet ${limit} Bytes`);
  return bytes;
}

const args = parseArgs(process.argv.slice(2));
const manifestPath = args.manifest || die('--manifest fehlt');
const signaturePath = args.signature || die('--signature fehlt');
const format = args.format ?? 'json';
if (format !== 'json' && format !== 'env') die('--format muss json oder env sein');

const body = readBounded(manifestPath, MAX_MANIFEST_BYTES, 'Manifest');
const signature = readBounded(signaturePath, MAX_SIGNATURE_BYTES, 'Signatur')
  .toString('utf8')
  .trim();
const publicKeyRaw = process.env['UPDATE_PUBLIC_KEY'] || die('ENV UPDATE_PUBLIC_KEY fehlt');
const publicKey = publicKeyRaw.includes('\\n')
  ? publicKeyRaw.replaceAll('\\n', '\n')
  : publicKeyRaw;
if (!verifyManifestSignature(body, signature, publicKey)) {
  die('Manifest-Signatur ungültig');
}

let manifest;
try {
  manifest = JSON.parse(body.toString('utf8'));
} catch (error) {
  die(`Manifest ist kein gültiges JSON: ${error.message}`);
}
const errors = validateUpdateManifestV2(manifest);
if (errors.length > 0) die(`Manifest-Schema ungültig: ${errors.join('; ')}`);

const version = args.version ?? manifest.current;
if (!SEMVER_RE.test(version)) die('--version muss X.Y.Z sein');
const entry = manifest.versions.find((candidate) => candidate.version === version);
if (!entry) die(`Version ${version} ist nicht im Manifest enthalten`);

const contract = {
  schemaVersion: manifest.schemaVersion,
  version: entry.version,
  commitSha: entry.commitSha,
  migrationsRequired: entry.migrationsRequired,
  ...(entry.minPreviousVersion ? { minPreviousVersion: entry.minPreviousVersion } : {}),
  web: {
    ...entry.artifacts.web,
    pinnedImage: `${entry.artifacts.web.image}@${entry.artifacts.web.digest}`,
  },
  worker: {
    ...entry.artifacts.worker,
    pinnedImage: `${entry.artifacts.worker.image}@${entry.artifacts.worker.digest}`,
  },
};

if (format === 'json') {
  process.stdout.write(`${JSON.stringify(contract)}\n`);
} else {
  // Alle Werte durch das strikte Schema auf shell-sichere Alphabete begrenzt.
  process.stdout.write(
    [
      `UPDATE_SCHEMA_VERSION=${contract.schemaVersion}`,
      `UPDATE_VERSION=${contract.version}`,
      `UPDATE_COMMIT_SHA=${contract.commitSha}`,
      `UPDATE_MIGRATIONS_REQUIRED=${contract.migrationsRequired}`,
      `UPDATE_MIN_PREVIOUS_VERSION=${contract.minPreviousVersion ?? ''}`,
      `UPDATE_WEB_IMAGE=${contract.web.image}`,
      `UPDATE_WEB_DIGEST=${contract.web.digest}`,
      `UPDATE_WEB_PINNED_IMAGE=${contract.web.pinnedImage}`,
      `UPDATE_WORKER_IMAGE=${contract.worker.image}`,
      `UPDATE_WORKER_DIGEST=${contract.worker.digest}`,
      `UPDATE_WORKER_PINNED_IMAGE=${contract.worker.pinnedImage}`,
      '',
    ].join('\n'),
  );
}
