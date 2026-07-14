#!/usr/bin/env node
import { createPrivateKey } from 'node:crypto';
import { pathToFileURL, URL } from 'node:url';

export function verifyReleaseConfig(env = process.env) {
  const manifestRepo = env.UPDATE_MANIFEST_REPO?.trim();
  const manifestToken = env.UPDATE_MANIFEST_TOKEN?.trim();
  const privateKeyRaw = env.UPDATE_MANIFEST_PRIVATE_KEY;

  if (!manifestRepo) throw new Error('vars.UPDATE_MANIFEST_REPO fehlt');
  if (!manifestToken) throw new Error('secrets.UPDATE_MANIFEST_TOKEN fehlt');
  if (!privateKeyRaw) throw new Error('secrets.UPDATE_MANIFEST_PRIVATE_KEY fehlt');

  let repoUrl;
  try {
    repoUrl = new URL(manifestRepo);
  } catch (error) {
    throw new Error('UPDATE_MANIFEST_REPO ist keine gültige URL', { cause: error });
  }
  if (repoUrl.protocol !== 'https:') {
    throw new Error('UPDATE_MANIFEST_REPO muss HTTPS verwenden');
  }
  if (repoUrl.username || repoUrl.password || repoUrl.search || repoUrl.hash) {
    throw new Error('UPDATE_MANIFEST_REPO darf keine Credentials, Query oder Fragment enthalten');
  }
  if (repoUrl.pathname === '/' || repoUrl.pathname === '') {
    throw new Error('UPDATE_MANIFEST_REPO muss auf ein Repository zeigen');
  }

  const pem = privateKeyRaw.includes('\\n') ? privateKeyRaw.replaceAll('\\n', '\n') : privateKeyRaw;
  let privateKey;
  try {
    privateKey = createPrivateKey(pem);
  } catch (error) {
    throw new Error(
      `UPDATE_MANIFEST_PRIVATE_KEY ist kein gültiger PEM-Schlüssel: ${error.message}`,
      { cause: error },
    );
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('UPDATE_MANIFEST_PRIVATE_KEY muss ein Ed25519-Schlüssel sein');
  }

  return { manifestRepo: repoUrl.toString() };
}

function main() {
  try {
    const result = verifyReleaseConfig();
    process.stdout.write(`Release-Konfiguration verifiziert: ${result.manifestRepo}\n`);
  } catch (error) {
    process.stderr.write(`RELEASE-GATE FEHLER: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
