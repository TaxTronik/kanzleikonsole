// =============================================================================
// Update-Manifest v2 bauen + signieren (Vendor-Seite, release.yml).
//
// UPDATE_MANIFEST_PRIVATE_KEY=<PKCS8-PEM> node scripts/release/build-update-manifest.mjs \
//   --version 0.2.0 --commit-sha <git-sha> \
//   --web-image git.example.de/taxtronik/web:0.2.0 \
//   --web-image-digest sha256:… \
//   --worker-image git.example.de/taxtronik/worker:0.2.0 \
//   --worker-image-digest sha256:… \
//   --migrations-required true [--notes-file /tmp/notes.txt] \
//   [--min-previous 0.1.0] [--in /pfad/manifest.json] --out-dir /pfad
//
// Schema v2 bindet Commit, Web-Image und Worker-Image samt Registry-Digests in
// dieselben Ed25519-signierten Bytes. Ein strikt gültiges altes Single-Image-
// Manifest wird sicher migriert, indem seine unvollständigen Einträge verworfen
// werden; fehlende Worker-Digests werden niemals erfunden oder übernommen.
// =============================================================================

import { createPrivateKey, createPublicKey, sign as cryptoSign } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COMMIT_SHA_RE,
  SEMVER_RE,
  SHA256_DIGEST_RE,
  UPDATE_MANIFEST_SCHEMA_VERSION,
  compareSemver,
  isLegacySingleImageManifest,
  isTaggedImageReference,
  validateUpdateManifestV2,
  verifyManifestSignature,
} from './update-manifest-format.mjs';

function die(msg) {
  process.stderr.write(`FEHLER: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const allowed = new Set([
    'version',
    'commit-sha',
    'web-image',
    'web-image-digest',
    'worker-image',
    'worker-image-digest',
    'migrations-required',
    'notes-file',
    'min-previous',
    'in',
    'out-dir',
  ]);
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) die(`Unerwartetes Argument: ${arg}`);
    const key = arg.slice(2);
    if (!allowed.has(key)) die(`Unbekannte Option: --${key}`);
    if (Object.hasOwn(out, key)) die(`Option --${key} wurde mehrfach angegeben`);
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) die(`Wert für --${key} fehlt`);
    out[key] = argv[++i];
  }
  return out;
}

function requireArg(args, key) {
  return args[key] || die(`--${key} fehlt`);
}

function parseImage(args, role, version) {
  const image = requireArg(args, `${role}-image`);
  const digest = requireArg(args, `${role}-image-digest`);
  if (!isTaggedImageReference(image) || !image.endsWith(`:${version}`)) {
    die(`--${role}-image muss ein getaggter Repository-Pfad mit :${version} sein`);
  }
  if (!SHA256_DIGEST_RE.test(digest)) {
    die(`--${role}-image-digest muss sha256:<hex64> sein`);
  }
  return { image, digest };
}

const args = parseArgs(process.argv.slice(2));
const version = requireArg(args, 'version');
if (!SEMVER_RE.test(version)) die(`--version muss X.Y.Z sein, nicht ${JSON.stringify(version)}`);

const commitSha = requireArg(args, 'commit-sha');
if (!COMMIT_SHA_RE.test(commitSha)) {
  die('--commit-sha muss ein kleingeschriebener Git-SHA (40 oder 64 Hex-Zeichen) sein');
}

const artifacts = {
  web: parseImage(args, 'web', version),
  worker: parseImage(args, 'worker', version),
};
if (artifacts.web.image === artifacts.worker.image) {
  die('Web- und Worker-Image müssen verschiedene Repository-Pfade verwenden');
}

const migrationsRequired = requireArg(args, 'migrations-required');
if (migrationsRequired !== 'true' && migrationsRequired !== 'false') {
  die('--migrations-required muss true|false sein');
}
const outDir = requireArg(args, 'out-dir');

if (args['min-previous']) {
  if (!SEMVER_RE.test(args['min-previous'])) die('--min-previous muss X.Y.Z sein');
  if (compareSemver(args['min-previous'], version) >= 0) {
    die('--min-previous muss kleiner als --version sein');
  }
}

const pemRaw =
  process.env['UPDATE_MANIFEST_PRIVATE_KEY'] ||
  die('ENV UPDATE_MANIFEST_PRIVATE_KEY fehlt (PKCS8-PEM, siehe generate-update-key.mjs)');
const pem = pemRaw.includes('\\n') ? pemRaw.replaceAll('\\n', '\n') : pemRaw;
let privateKey;
try {
  privateKey = createPrivateKey(pem);
} catch (e) {
  die(`UPDATE_MANIFEST_PRIVATE_KEY ist kein gültiger PEM-Schlüssel: ${e.message}`);
}
if (privateKey.asymmetricKeyType !== 'ed25519') {
  die('UPDATE_MANIFEST_PRIVATE_KEY muss ein Ed25519-Schlüssel sein');
}

let manifest = {
  schemaVersion: UPDATE_MANIFEST_SCHEMA_VERSION,
  current: version,
  channel: 'stable',
  versions: [],
};
if (args.in) {
  if (!existsSync(args.in)) die(`--in ${args.in} existiert nicht`);
  const previousSignaturePath = `${args.in}.sig`;
  if (!existsSync(previousSignaturePath)) {
    die(`--in ${args.in}: benachbarte Signatur ${previousSignaturePath} fehlt`);
  }
  let previousBytes;
  let previousSignature;
  try {
    previousBytes = readFileSync(args.in);
    previousSignature = readFileSync(previousSignaturePath, 'utf8').trim();
  } catch (e) {
    die(`--in ${args.in} oder Signatur nicht lesbar: ${e.message}`);
  }
  if (previousBytes.length > 1024 * 1024) die(`--in ${args.in} überschreitet 1 MiB`);
  if (previousSignature.length > 4096) die(`${previousSignaturePath} überschreitet 4096 Zeichen`);
  const signingPublicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  if (!verifyManifestSignature(previousBytes, previousSignature, signingPublicKey)) {
    die(`--in ${args.in}: Signatur ist ungültig oder stammt von einem anderen Schlüssel`);
  }
  let previous;
  try {
    previous = JSON.parse(previousBytes.toString('utf8'));
  } catch (e) {
    die(`--in ${args.in} ist kein gültiges JSON: ${e.message}`);
  }

  if (isLegacySingleImageManifest(previous)) {
    // Die alte Form hat keinen Worker-Digest und kann deshalb nicht sicher in
    // einen v2-Eintrag konvertiert werden. Historie verwerfen statt raten.
    process.stderr.write(
      'WARNUNG: Single-Image-Manifest v1 erkannt; alte Einträge werden bei der ' +
        'Migration auf v2 verworfen (Worker-Digests fehlen).\n',
    );
    manifest.channel = previous.channel;
  } else {
    const errors = validateUpdateManifestV2(previous);
    if (errors.length > 0) {
      die(`--in ${args.in} verletzt Manifest-Schema v2: ${errors.join('; ')}`);
    }
    manifest = previous;
  }
}

const entry = {
  version,
  releasedAt: new Date().toISOString(),
  commitSha,
  artifacts,
  migrationsRequired: migrationsRequired === 'true',
};
if (args['min-previous']) entry.minPreviousVersion = args['min-previous'];
if (args['notes-file']) {
  let notes;
  try {
    notes = readFileSync(args['notes-file'], 'utf8').trim();
  } catch (e) {
    die(`--notes-file nicht lesbar: ${e.message}`);
  }
  if (notes.length > 100_000) die('--notes-file überschreitet 100000 Zeichen');
  if (notes) entry.notes = notes;
}

const existing = manifest.versions.find((candidate) => candidate.version === version);
if (existing) {
  const immutableFields = (candidate) => ({
    version: candidate.version,
    commitSha: candidate.commitSha,
    artifacts: {
      web: {
        image: candidate.artifacts.web.image,
        digest: candidate.artifacts.web.digest,
      },
      worker: {
        image: candidate.artifacts.worker.image,
        digest: candidate.artifacts.worker.digest,
      },
    },
    migrationsRequired: candidate.migrationsRequired,
    minPreviousVersion: candidate.minPreviousVersion ?? null,
    notes: candidate.notes ?? null,
  });
  if (JSON.stringify(immutableFields(existing)) !== JSON.stringify(immutableFields(entry))) {
    die(`Version ${version} existiert bereits mit abweichendem Commit, Digest oder Metadaten`);
  }
  // Idempotenter Re-Run: ursprünglichen Zeitpunkt und Bytes beibehalten.
  manifest.versions = manifest.versions.slice();
} else {
  manifest.versions = [...manifest.versions, entry];
}
manifest.versions.sort((a, b) => compareSemver(b.version, a.version));
manifest.current = manifest.versions[0].version;
manifest.schemaVersion = UPDATE_MANIFEST_SCHEMA_VERSION;
manifest.channel ||= 'stable';

const validationErrors = validateUpdateManifestV2(manifest);
if (validationErrors.length > 0) {
  die(`Erzeugtes Manifest ist ungültig: ${validationErrors.join('; ')}`);
}

const body = JSON.stringify(manifest, null, 2) + '\n';
const signature = `ed25519:${cryptoSign(null, Buffer.from(body, 'utf8'), privateKey).toString('base64')}`;

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'manifest.json'), body, 'utf8');
writeFileSync(join(outDir, 'manifest.json.sig'), signature, 'utf8');

process.stdout.write(
  `manifest.json v${UPDATE_MANIFEST_SCHEMA_VERSION} geschrieben: current=${manifest.current}, ` +
    `${manifest.versions.length} Version(en), ${version} @ ${commitSha.slice(0, 12)} ` +
    `(web=${artifacts.web.digest}, worker=${artifacts.worker.digest})\n`,
);
