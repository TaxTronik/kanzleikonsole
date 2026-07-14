#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function verifyReleaseVersion({ tag, packageJson, changelog }) {
  const match = /^v(\d+\.\d+\.\d+)$/.exec(tag ?? '');
  if (!match) throw new Error('Release-Tag muss exakt vX.Y.Z sein');
  const version = match[1];

  let manifest;
  try {
    manifest = JSON.parse(packageJson);
  } catch (error) {
    throw new Error('package.json ist kein gültiges JSON', { cause: error });
  }
  if (manifest.version !== version) {
    throw new Error(`Tag ${tag} stimmt nicht mit package.json (${manifest.version ?? 'fehlt'}) überein`);
  }

  const heading = new RegExp(`^## \\[${version.replaceAll('.', '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm');
  if (!heading.test(changelog)) {
    throw new Error(`CHANGELOG.md enthält keinen datierten Abschnitt für ${version}`);
  }
  return version;
}

function main() {
  try {
    const tagIndex = process.argv.indexOf('--tag');
    const tag = tagIndex >= 0 ? process.argv[tagIndex + 1] : process.env.GITHUB_REF_NAME;
    const version = verifyReleaseVersion({
      tag,
      packageJson: readFileSync('package.json', 'utf8'),
      changelog: readFileSync('CHANGELOG.md', 'utf8'),
    });
    process.stdout.write(`Release-Version ${version}: Tag, package.json und Changelog stimmen überein.\n`);
  } catch (error) {
    process.stderr.write(`RELEASE-VERSION FEHLER: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
