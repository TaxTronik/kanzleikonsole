#!/usr/bin/env node
// =============================================================================
// Aktualisiert den vendored TCMS-Vertrag (packages/tcms-contract, TCMS Stufe 2).
//
//   node scripts/tcms/sync-contract.mjs --from <tcms-checkout> [--repo <name>]
//
// Kopiert alle versionierten Dateien unter packages/contract/src des Checkouts
// außer Tests (`__tests__/`, `*.test.*`) nach packages/tcms-contract/src,
// entfernt dort alles andere und schreibt VENDOR.json mit Quell-Commit
// (`git rev-parse HEAD`) und SHA-256 je Datei. Verweigert bei schmutzigem
// Quellbaum (geänderte, gestagte oder unversionierte Dateien): Der Commit in
// VENDOR.json soll den kopierten Stand exakt reproduzieren. `--ziel` (nur für
// Tests) setzt ein anderes Paketverzeichnis. Der Checkout wird nur gelesen.
// =============================================================================

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  QUELL_PFAD,
  VENDOR_BESCHREIBUNG,
  VENDOR_DATEI,
  ZIEL_PAKET,
  istSichererPfad,
  istTestdatei,
  pruefeVendorDaten,
  sha256,
} from './vendor-lib.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function fehler(meldung) {
  process.stderr.write(`sync-contract: ${meldung}\n`);
  process.exit(1);
}

function argumente(argv) {
  const werte = { from: null, repo: 'tcms', ziel: join(REPO_ROOT, ZIEL_PAKET) };
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    const wert = argv[i + 1];
    if (wert === undefined || wert.startsWith('--')) fehler(`${name} braucht einen Wert`);
    if (name === '--from') werte.from = resolve(wert);
    else if (name === '--repo') werte.repo = wert;
    else if (name === '--ziel') werte.ziel = resolve(wert);
    else fehler(`unbekanntes Argument ${name}`);
  }
  if (!werte.from) fehler('Aufruf: node scripts/tcms/sync-contract.mjs --from <tcms-checkout>');
  return werte;
}

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

const args = argumente(process.argv.slice(2));
let wurzel;
try {
  wurzel = git(args.from, ['rev-parse', '--show-toplevel']).trim();
} catch {
  fehler('--from ist kein Git-Checkout');
}
const schmutzig = git(wurzel, ['status', '--porcelain=v1', '--untracked-files=all']);
if (schmutzig.trim() !== '') {
  fehler(
    'Quellbaum hat ungesicherte Änderungen oder unversionierte Dateien – erst committen oder verwerfen',
  );
}
const commit = git(wurzel, ['rev-parse', 'HEAD']).trim();
const dateien = git(wurzel, ['ls-files', '-z', '--', QUELL_PFAD])
  .split('\0')
  .filter(Boolean)
  .map((pfad) => pfad.slice(QUELL_PFAD.length + 1))
  .filter((pfad) => !istTestdatei(pfad))
  .sort();
if (dateien.length === 0) fehler(`${QUELL_PFAD} enthält keine Dateien`);
for (const pfad of dateien) {
  if (!istSichererPfad(pfad)) fehler(`unzulässiger Dateiname unter ${QUELL_PFAD}`);
}

const srcZiel = join(args.ziel, 'src');
rmSync(srcZiel, { recursive: true, force: true });
const eintraege = dateien.map((pfad) => {
  const bytes = readFileSync(join(wurzel, QUELL_PFAD, pfad));
  mkdirSync(dirname(join(srcZiel, pfad)), { recursive: true });
  writeFileSync(join(srcZiel, pfad), bytes);
  return { pfad, sha256: sha256(bytes) };
});
const vendor = {
  beschreibung: VENDOR_BESCHREIBUNG,
  quelle: { repo: args.repo, pfad: QUELL_PFAD, commit },
  dateien: eintraege,
};
const befunde = pruefeVendorDaten(vendor);
if (befunde.length > 0) fehler(befunde.join('; '));
writeFileSync(join(args.ziel, VENDOR_DATEI), `${JSON.stringify(vendor, null, 2)}\n`);
process.stdout.write(
  `sync-contract: ${eintraege.length} Dateien aus ${args.repo}@${commit.slice(0, 12)} übernommen.\n`,
);
