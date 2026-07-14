#!/usr/bin/env node

import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, relative, resolve, sep } from 'node:path';

const SCHEMA = 'taxtronik-full-backup-manifest/v1';
const MANIFEST_NAME = 'manifest.json';
const SIGNATURE_NAME = 'manifest.json.sig';

function fail(message) {
  process.stderr.write(`FEHLER: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith('--') || value === undefined) fail(`Ungueltiges Argument: ${flag ?? ''}`);
    args[flag.slice(2)] = value;
  }
  return args;
}

function required(args, key) {
  return args[key] || fail(`--${key} fehlt`);
}

function keyId(key) {
  const publicKey = key.type === 'public' ? key : createPublicKey(key);
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return `ed25519-sha256:${createHash('sha256').update(der).digest('base64url')}`;
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function inventory(root) {
  const files = [];

  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const absolute = resolve(directory, entry.name);
      const path = relative(root, absolute).split(sep).join('/');
      if (path === MANIFEST_NAME || path === SIGNATURE_NAME) continue;
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) fail(`Symlinks sind im Backup nicht erlaubt: ${path}`);
      if (metadata.isDirectory()) {
        await walk(absolute);
      } else if (metadata.isFile()) {
        files.push({ path, size: metadata.size, sha256: await hashFile(absolute) });
      } else {
        fail(`Nicht-regulaere Datei im Backup: ${path}`);
      }
    }
  }

  await walk(root);
  return files;
}

async function assertSafeRoot(input) {
  const root = await realpath(resolve(input));
  const metadata = await stat(root);
  if (!metadata.isDirectory()) fail(`Backup-Root ist kein Verzeichnis: ${root}`);
  return root;
}

async function createManifest(args) {
  const root = await assertSafeRoot(required(args, 'root'));
  const privateKeyPath = required(args, 'private-key');
  const files = await inventory(root);
  if (files.length === 0) fail('Backup enthaelt keine Dateien');

  let privateKey;
  try {
    privateKey = createPrivateKey(await readFile(privateKeyPath, 'utf8'));
  } catch (error) {
    fail(`Privater Manifest-Schluessel ungueltig: ${error.message}`);
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') fail('Manifest-Schluessel muss Ed25519 sein');

  const manifest = {
    schema: SCHEMA,
    keyId: keyId(privateKey),
    backupId: basename(root),
    createdAt: new Date().toISOString(),
    installationVersion: args.version || 'unknown',
    sourceCommit: args.commit || 'unknown',
    files,
  };
  const body = `${JSON.stringify(manifest, null, 2)}\n`;
  const signature = sign(null, Buffer.from(body), privateKey).toString('base64');
  await writeFile(resolve(root, MANIFEST_NAME), body, { mode: 0o600 });
  await writeFile(resolve(root, SIGNATURE_NAME), `ed25519:${signature}\n`, { mode: 0o600 });
  process.stdout.write(`${resolve(root, MANIFEST_NAME)}\n`);
}

function parseManifest(raw) {
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    fail(`Manifest ist kein gueltiges JSON: ${error.message}`);
  }
  if (
    manifest?.schema !== SCHEMA ||
    !/^ed25519-sha256:[A-Za-z0-9_-]{43}$/.test(manifest.keyId ?? '') ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0
  ) {
    fail(`Manifest-Schema ungueltig (erwartet ${SCHEMA})`);
  }
  const paths = new Set();
  for (const entry of manifest.files) {
    if (
      typeof entry?.path !== 'string' ||
      entry.path.startsWith('/') ||
      entry.path
        .split('/')
        .some((segment) => segment === '..' || segment === '.' || segment === '') ||
      entry.path.includes('\\') ||
      typeof entry.size !== 'number' ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      !/^[0-9a-f]{64}$/.test(entry.sha256) ||
      paths.has(entry.path)
    ) {
      fail(`Ungueltiger Manifest-Eintrag: ${JSON.stringify(entry)}`);
    }
    paths.add(entry.path);
  }
  return manifest;
}

async function verifyManifest(args) {
  const root = await assertSafeRoot(required(args, 'root'));
  const manifestPath = resolve(root, MANIFEST_NAME);
  const signaturePath = resolve(root, SIGNATURE_NAME);
  const body = await readFile(manifestPath, 'utf8').catch((error) =>
    fail(`Manifest fehlt: ${error.message}`),
  );
  const signatureText = (
    await readFile(signaturePath, 'utf8').catch((error) => fail(`Signatur fehlt: ${error.message}`))
  ).trim();
  const match = /^ed25519:([A-Za-z0-9+/=]+)$/.exec(signatureText);
  if (!match) fail('Manifest-Signatur hat ein ungueltiges Format');

  let publicKey;
  try {
    publicKey = createPublicKey(await readFile(required(args, 'public-key'), 'utf8'));
  } catch (error) {
    fail(`Oeffentlicher Manifest-Schluessel ungueltig: ${error.message}`);
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') fail('Manifest-Schluessel muss Ed25519 sein');
  const manifest = parseManifest(body);
  if (manifest.keyId !== keyId(publicKey))
    fail('Manifest-Key-ID stimmt nicht mit dem Public Key ueberein');
  if (!verify(null, Buffer.from(body), publicKey, Buffer.from(match[1], 'base64'))) {
    fail('Manifest-Signatur ist ungueltig');
  }

  const expected = manifest.files;
  const actual = await inventory(root);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const expectedByPath = new Map(expected.map((entry) => [entry.path, entry]));
    const actualByPath = new Map(actual.map((entry) => [entry.path, entry]));
    for (const [path, entry] of expectedByPath) {
      const found = actualByPath.get(path);
      if (!found) process.stderr.write(`FEHLT: ${path}\n`);
      else if (found.size !== entry.size || found.sha256 !== entry.sha256)
        process.stderr.write(`VERAENDERT: ${path}\n`);
    }
    for (const path of actualByPath.keys()) {
      if (!expectedByPath.has(path)) process.stderr.write(`UNERWARTET: ${path}\n`);
    }
    fail('Backup-Inventar stimmt nicht mit dem signierten Manifest ueberein');
  }
  process.stdout.write(`OK ${expected.length} Dateien, Signatur und SHA-256-Inventar gueltig.\n`);
}

async function generateKey(args) {
  const { generateKeyPairSync } = await import('node:crypto');
  const output = resolve(required(args, 'out-dir'));
  await mkdir(output, { recursive: true, mode: 0o700 });
  const privatePath = resolve(output, 'backup-manifest-private.pem');
  const publicPath = resolve(output, 'backup-manifest-public.pem');
  for (const path of [privatePath, publicPath]) {
    try {
      await lstat(path);
      fail(`Schluesseldatei existiert bereits und wird nicht ueberschrieben: ${path}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  try {
    await writeFile(privatePath, privateKey.export({ format: 'pem', type: 'pkcs8' }), {
      mode: 0o600,
      flag: 'wx',
    });
    await writeFile(publicPath, publicKey.export({ format: 'pem', type: 'spki' }), {
      mode: 0o644,
      flag: 'wx',
    });
  } catch (error) {
    fail(`Schluesseldateien werden nicht ueberschrieben: ${error.message}`);
  }
  process.stdout.write(`${output}\nKey-ID: ${keyId(publicKey)}\n`);
}

const args = parseArgs(process.argv.slice(2));
if (args.command === 'create') await createManifest(args);
else if (args.command === 'verify') await verifyManifest(args);
else if (args.command === 'generate-key') await generateKey(args);
else fail('Nutzung: manifest.mjs create|verify|generate-key ...');
