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
//
// Gelesen wird ausschließlich aus der Objektdatenbank des Commits
// (`git ls-tree` + `git cat-file blob`), nie aus dem Arbeitsbaum: Die Kopie ist
// damit byte-genau der auditierbare Git-Blob. Jeder Eintrag, der keine normale
// Datei ist (Symlink 120000, ausführbar 100755, Submodul 160000), bricht ab –
// sonst ließe sich über einen harmlos aussehenden Symlink-Blob Fremdinhalt
// vendoren, den weder Guard noch Quellabgleich sehen (Red Team RT2-K-01).
// =============================================================================

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
/** Einträge des Commits unter QUELL_PFAD: Modus, Typ, Objekt-ID, Pfad. */
const baum = execFileSync(
  'git',
  ['-C', wurzel, 'ls-tree', '-r', '-z', '--full-tree', commit, '--', QUELL_PFAD],
  {
    encoding: 'utf8',
  },
)
  .split('\0')
  .filter(Boolean)
  .map((zeile) => {
    const tab = zeile.indexOf('\t');
    const [modus, typ, objekt] = zeile.slice(0, tab).split(' ');
    return { modus, typ, objekt, pfad: zeile.slice(tab + 1).slice(QUELL_PFAD.length + 1) };
  })
  .filter((eintrag) => !istTestdatei(eintrag.pfad))
  .sort((a, b) => (a.pfad < b.pfad ? -1 : a.pfad > b.pfad ? 1 : 0));
if (baum.length === 0) fehler(`${QUELL_PFAD} enthält keine Dateien`);
for (const eintrag of baum) {
  if (!istSichererPfad(eintrag.pfad)) fehler(`unzulässiger Dateiname unter ${QUELL_PFAD}`);
  if (
    eintrag.modus !== '100644' ||
    eintrag.typ !== 'blob' ||
    !/^[0-9a-f]{40,64}$/.test(eintrag.objekt)
  ) {
    fehler(
      `${QUELL_PFAD}/${eintrag.pfad} ist keine normale Datei (Modus ${eintrag.modus}); Symlinks, ausführbare Dateien und Submodule werden nicht übernommen`,
    );
  }
}

const srcZiel = join(args.ziel, 'src');
rmSync(srcZiel, { recursive: true, force: true });
const eintraege = baum.map(({ pfad, objekt }) => {
  const bytes = execFileSync('git', ['-C', wurzel, 'cat-file', 'blob', objekt], {
    maxBuffer: 16 * 1024 * 1024,
  });
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
