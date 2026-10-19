#!/usr/bin/env node
// =============================================================================
// Guard: packages/tcms-contract entspricht exakt seinem VENDOR.json
// (TCMS Stufe 2). Keine lokalen Änderungen am vendored Vertrag, keine fehlenden
// oder zusätzlichen Dateien. Änderungen am Vertrag entstehen im TCMS-Repo und
// kommen ausschließlich über scripts/tcms/sync-contract.mjs herein.
// =============================================================================

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ZIEL_PAKET, pruefeVendor } from './tcms/vendor-lib.mjs';

export function pruefeTcmsVertrag(repoRoot) {
  return pruefeVendor(join(repoRoot, ZIEL_PAKET));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const befunde = pruefeTcmsVertrag(repoRoot);
  if (befunde.length > 0) {
    process.stderr.write(
      `check-tcms-contract-vendor: ${ZIEL_PAKET} weicht von VENDOR.json ab:\n` +
        befunde.map((b) => `  - ${b}\n`).join('') +
        'Vertrag nur über scripts/tcms/sync-contract.mjs aktualisieren (docs/development/tcms-anbindung.md).\n',
    );
    process.exit(1);
  }
  process.stdout.write(`check-tcms-contract-vendor: ${ZIEL_PAKET} entspricht VENDOR.json.\n`);
}
