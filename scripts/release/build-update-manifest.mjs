// =============================================================================
// Update-Manifest bauen + signieren (Vendor-Seite, läuft in release.yml).
//
//   UPDATE_MANIFEST_PRIVATE_KEY=<PKCS8-PEM> node scripts/release/build-update-manifest.mjs \
//     --version 1.4.0 \
//     --image git.example.de/taxtronik/web:1.4.0 \
//     --image-digest sha256:… \
//     --migrations-required true \
//     [--notes-file /tmp/notes.txt] [--min-previous 1.3.0] \
//     [--in /pfad/manifest.json] --out-dir /pfad
//
// Schreibt <out-dir>/manifest.json + <out-dir>/manifest.json.sig. Die Signatur
// (`ed25519:<base64>`) läuft über EXAKT die geschriebenen Manifest-Bytes —
// verifiziert von apps/web/src/server/update/manifest.ts (Header-Variante
// X-Manifest-Signature ODER detached <url>.sig; statisches Hosting nutzt die
// detached Datei). Idempotent: existiert die Version schon, wird ihr Eintrag
// ersetzt (Re-Run eines Release-Jobs erzeugt keine Duplikate).
// =============================================================================

import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

function die(msg) {
  process.stderr.write(`FEHLER: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) die(`Unerwartetes Argument: ${a}`);
    out[a.slice(2)] = argv[++i];
  }
  return out;
}

/** Minimaler Semver-Vergleich — identisch zu manifest.ts (X.Y.Z, ohne pre-release). */
function semverGt(a, b) {
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

const args = parseArgs(process.argv.slice(2));

const version = args.version || die('--version fehlt');
if (!/^\d+\.\d+\.\d+$/.test(version)) die(`--version muss X.Y.Z sein, nicht ${JSON.stringify(version)}`);
const image = args.image || die('--image fehlt');
const imageDigest = args['image-digest'] || die('--image-digest fehlt');
if (!/^sha256:[0-9a-f]{64}$/.test(imageDigest)) die(`--image-digest muss sha256:<hex64> sein`);
const migrationsRequired = args['migrations-required'];
if (migrationsRequired !== 'true' && migrationsRequired !== 'false') {
  die('--migrations-required muss true|false sein');
}
const outDir = args['out-dir'] || die('--out-dir fehlt');

const pemRaw = process.env['UPDATE_MANIFEST_PRIVATE_KEY'] || die('ENV UPDATE_MANIFEST_PRIVATE_KEY fehlt (PKCS8-PEM, siehe generate-update-key.mjs)');
// Secrets-UIs verlieren gelegentlich echte Zeilenumbrüche — \n-Escapes tolerieren.
const pem = pemRaw.includes('\\n') ? pemRaw.replaceAll('\\n', '\n') : pemRaw;
let privateKey;
try {
  privateKey = createPrivateKey(pem);
} catch (e) {
  die(`UPDATE_MANIFEST_PRIVATE_KEY ist kein gültiger PEM-Schlüssel: ${e.message}`);
}
if (privateKey.asymmetricKeyType !== 'ed25519') die('UPDATE_MANIFEST_PRIVATE_KEY muss ein Ed25519-Schlüssel sein');

// Bestehendes Manifest fortschreiben (oder frisch starten).
let manifest = { current: version, channel: 'stable', versions: [] };
if (args.in) {
  if (!existsSync(args.in)) die(`--in ${args.in} existiert nicht`);
  try {
    manifest = JSON.parse(readFileSync(args.in, 'utf8'));
  } catch (e) {
    die(`--in ${args.in} ist kein gültiges JSON: ${e.message}`);
  }
  if (!Array.isArray(manifest.versions)) die(`--in ${args.in}: Feld 'versions' fehlt/ungültig`);
}

const entry = {
  version,
  releasedAt: new Date().toISOString(),
  image,
  imageDigest,
  migrationsRequired: migrationsRequired === 'true',
};
if (args['min-previous']) entry.minPreviousVersion = args['min-previous'];
if (args['notes-file']) {
  const notes = readFileSync(args['notes-file'], 'utf8').trim();
  if (notes) entry.notes = notes;
}

manifest.versions = [entry, ...manifest.versions.filter((v) => v.version !== version)];
// `current` = höchste enthaltene Version (nicht blind die neue — ein Re-Run
// für einen alten Hotfix-Tag darf current nicht zurückdrehen).
manifest.current = manifest.versions.reduce(
  (max, v) => (semverGt(v.version, max) ? v.version : max),
  manifest.versions[0].version,
);
manifest.channel = manifest.channel || 'stable';

const body = JSON.stringify(manifest, null, 2) + '\n';
const signature = `ed25519:${cryptoSign(null, Buffer.from(body, 'utf8'), privateKey).toString('base64')}`;

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'manifest.json'), body, 'utf8');
// Exakt der Header-/Sig-Datei-Wert, ohne Newline — der Client trimmt ohnehin.
writeFileSync(join(outDir, 'manifest.json.sig'), signature, 'utf8');

process.stdout.write(
  `manifest.json geschrieben: current=${manifest.current}, ${manifest.versions.length} Version(en), ` +
    `neu/ersetzt: ${version} (migrationsRequired=${entry.migrationsRequired})\n`,
);
