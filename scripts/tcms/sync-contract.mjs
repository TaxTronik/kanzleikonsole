#!/usr/bin/env node
// =============================================================================
// Aktualisiert die vendorten TCMS-Pakete (TCMS Stufe 2; ab Stufe 3 mehrere
// Pakete, Liste VENDOR_PAKETE in scripts/tcms/vendor-lib.mjs).
//
//   node scripts/tcms/sync-contract.mjs --from <tcms-checkout> [--paket <name>] [--repo <name>]
//
// Ohne `--paket` werden alle Pakete aus demselben Commit übernommen; mit
// `--paket contract` bzw. `--paket domain` nur dieses eine. Je Paket: alle
// versionierten Dateien unter seinem Quellpfad außer Tests (`__tests__/`,
// `*.test.*`) und den Ausschlüssen des Pakets nach <zielPaket>/src, dort alles
// andere entfernen, VENDOR.json mit Quell-Commit (`git rev-parse HEAD`) und
// SHA-256 je Datei schreiben. Verweigert bei schmutzigem Quellbaum (geänderte,
// gestagte oder unversionierte Dateien): Der Commit in VENDOR.json soll den
// kopierten Stand exakt reproduzieren. Nur für Tests: `--ziel <dir>` (nur
// zusammen mit `--paket`) setzt ein anderes Paketverzeichnis, `--wurzel <dir>`
// eine andere Repository-Wurzel für alle Pakete. Der Checkout wird nur gelesen.
//
// Gelesen wird ausschließlich aus der Objektdatenbank des Commits
// (`git ls-tree` + `git cat-file blob`), nie aus dem Arbeitsbaum: Die Kopie ist
// damit byte-genau der auditierbare Git-Blob. Jeder Eintrag, der keine normale
// Datei ist (Symlink 120000, ausführbar 100755, Submodul 160000), bricht ab –
// sonst ließe sich über einen harmlos aussehenden Symlink-Blob Fremdinhalt
// vendoren, den weder Guard noch Quellabgleich sehen (Red Team RT2-K-01).
// Alle Pakete werden vor dem ersten Schreibzugriff geprüft.
// =============================================================================

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VENDOR_DATEI,
  VENDOR_PAKETE,
  istAusgeschlossen,
  istSichererPfad,
  pruefeVendorDaten,
  sha256,
  vendorPaket,
} from './vendor-lib.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function fehler(meldung) {
  process.stderr.write(`sync-contract: ${meldung}\n`);
  process.exit(1);
}

function argumente(argv) {
  const werte = { from: null, repo: 'tcms', paket: null, ziel: null, wurzel: REPO_ROOT };
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    const wert = argv[i + 1];
    if (wert === undefined || wert.startsWith('--')) fehler(`${name} braucht einen Wert`);
    if (name === '--from') werte.from = resolve(wert);
    else if (name === '--repo') werte.repo = wert;
    else if (name === '--paket') werte.paket = wert;
    else if (name === '--ziel') werte.ziel = resolve(wert);
    else if (name === '--wurzel') werte.wurzel = resolve(wert);
    else fehler(`unbekanntes Argument ${name}`);
  }
  if (!werte.from) fehler('Aufruf: node scripts/tcms/sync-contract.mjs --from <tcms-checkout>');
  if (werte.paket !== null && !vendorPaket(werte.paket)) {
    fehler(`--paket muss einer von ${VENDOR_PAKETE.map((p) => p.name).join(', ')} sein`);
  }
  if (werte.ziel !== null && werte.paket === null) fehler('--ziel nur zusammen mit --paket');
  return werte;
}

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

/** Einträge des Commits unter dem Quellpfad des Pakets, ohne Tests und Ausschlüsse. */
function baumDesPakets(wurzel, commit, paket) {
  const baum = git(wurzel, ['ls-tree', '-r', '-z', '--full-tree', commit, '--', paket.quellPfad])
    .split('\0')
    .filter(Boolean)
    .map((zeile) => {
      const tab = zeile.indexOf('\t');
      const [modus, typ, objekt] = zeile.slice(0, tab).split(' ');
      return {
        modus,
        typ,
        objekt,
        pfad: zeile.slice(tab + 1).slice(paket.quellPfad.length + 1),
      };
    })
    .filter((eintrag) => !istAusgeschlossen(eintrag.pfad, paket))
    .sort((a, b) => (a.pfad < b.pfad ? -1 : a.pfad > b.pfad ? 1 : 0));
  if (baum.length === 0) fehler(`${paket.quellPfad} enthält keine Dateien`);
  for (const eintrag of baum) {
    if (!istSichererPfad(eintrag.pfad)) fehler(`unzulässiger Dateiname unter ${paket.quellPfad}`);
    if (
      eintrag.modus !== '100644' ||
      eintrag.typ !== 'blob' ||
      !/^[0-9a-f]{40,64}$/.test(eintrag.objekt)
    ) {
      fehler(
        `${paket.quellPfad}/${eintrag.pfad} ist keine normale Datei (Modus ${eintrag.modus}); Symlinks, ausführbare Dateien und Submodule werden nicht übernommen`,
      );
    }
  }
  return baum;
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
const pakete = args.paket === null ? VENDOR_PAKETE : [vendorPaket(args.paket)];

// Erst alle Pakete lesen und prüfen (Blobs, VENDOR.json), dann schreiben: ein
// abgewiesenes Paket lässt auch die anderen unverändert.
const plaene = pakete.map((paket) => {
  const dateien = baumDesPakets(wurzel, commit, paket).map(({ pfad, objekt }) => ({
    pfad,
    bytes: execFileSync('git', ['-C', wurzel, 'cat-file', 'blob', objekt], {
      maxBuffer: 16 * 1024 * 1024,
    }),
  }));
  const vendor = {
    beschreibung: paket.beschreibung,
    quelle: { repo: args.repo, pfad: paket.quellPfad, commit },
    dateien: dateien.map(({ pfad, bytes }) => ({ pfad, sha256: sha256(bytes) })),
  };
  const befunde = pruefeVendorDaten(vendor, paket);
  if (befunde.length > 0) fehler(`${paket.name}: ${befunde.join('; ')}`);
  return { paket, ziel: args.ziel ?? join(args.wurzel, paket.zielPaket), dateien, vendor };
});

for (const { paket, ziel, dateien, vendor } of plaene) {
  const srcZiel = join(ziel, 'src');
  rmSync(srcZiel, { recursive: true, force: true });
  for (const { pfad, bytes } of dateien) {
    mkdirSync(dirname(join(srcZiel, pfad)), { recursive: true });
    writeFileSync(join(srcZiel, pfad), bytes);
  }
  writeFileSync(join(ziel, VENDOR_DATEI), `${JSON.stringify(vendor, null, 2)}\n`);
  process.stdout.write(
    `sync-contract: ${paket.name}: ${dateien.length} Dateien aus ${args.repo}@${commit.slice(0, 12)} übernommen.\n`,
  );
}
