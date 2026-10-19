#!/usr/bin/env node
// =============================================================================
// Guard: jedes vendorte TCMS-Paket (VENDOR_PAKETE in scripts/tcms/vendor-lib.mjs:
// packages/tcms-contract, packages/tcms-domain) entspricht exakt seinem
// VENDOR.json (TCMS Stufe 2; mehrere Pakete ab Stufe 3). Keine lokalen
// Änderungen, keine fehlenden oder zusätzlichen Dateien, kein VENDOR.json
// eines anderen Pakets. Änderungen entstehen im TCMS-Repo und kommen
// ausschließlich über scripts/tcms/sync-contract.mjs herein.
// =============================================================================

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { VENDOR_PAKETE, pruefeVendor } from './tcms/vendor-lib.mjs';

/** Befunde aller Pakete, je Befund mit Paketverzeichnis davor; leer = alles in Ordnung. */
export function pruefeTcmsVendor(repoRoot) {
  return VENDOR_PAKETE.flatMap((paket) =>
    pruefeVendor(join(repoRoot, paket.zielPaket), paket).map(
      (befund) => `${paket.zielPaket}: ${befund}`,
    ),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const befunde = pruefeTcmsVendor(repoRoot);
  if (befunde.length > 0) {
    process.stderr.write(
      'check-tcms-contract-vendor: vendorte TCMS-Pakete weichen von VENDOR.json ab:\n' +
        befunde.map((b) => `  - ${b}\n`).join('') +
        'Pakete nur über scripts/tcms/sync-contract.mjs aktualisieren (docs/development/tcms-anbindung.md).\n',
    );
    process.exit(1);
  }
  process.stdout.write(
    `check-tcms-contract-vendor: ${VENDOR_PAKETE.map((p) => p.zielPaket).join(', ')} entsprechen VENDOR.json.\n`,
  );
}
