// =============================================================================
// Gemeinsame Bausteine für die vendorten TCMS-Pakete (TCMS Stufe 2; ab Stufe 3
// mehrere Pakete).
//
// Jedes Paket in VENDOR_PAKETE ist eine exakte Kopie eines Quellpfads im
// TCMS-Repo ohne Tests und ohne die genannten Ausschlüsse. `VENDOR.json` im
// Paket hält Quell-Repo, Quellpfad, Quell-Commit und je Datei den SHA-256 fest.
// Das Sync-Skript (scripts/tcms/sync-contract.mjs) schreibt beides, der Guard
// (scripts/check-tcms-contract-vendor.mjs) prüft für jedes Paket, dass der
// Arbeitsbaum exakt seinem `VENDOR.json` entspricht: keine lokalen
// Änderungen, keine fehlenden und keine zusätzlichen Dateien, keine Symlinks.
//
// Die Liste ist wortgleich mit PAKETE in scripts/vertrag-export.mjs des
// TCMS-Repos (Quellpfad, Ausschlüsse, Beschreibung): Der Export dort erzeugt
// für denselben Commit dasselbe VENDOR.json wie das Sync-Skript hier.
// =============================================================================

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

/**
 * @typedef {object} VendorPaket
 * @property {string} name        Kurzname für `--paket` (`contract`, `domain`).
 * @property {string} quellPfad   Pfad im TCMS-Repo.
 * @property {string} zielPaket   Paketverzeichnis der Kopie relativ zum Repository.
 * @property {readonly string[]} ausschluesse Exakte Pfade relativ zu `quellPfad`, die nicht kopiert werden.
 * @property {string} beschreibung Feld `beschreibung` in VENDOR.json.
 */

/** @type {readonly VendorPaket[]} */
export const VENDOR_PAKETE = Object.freeze([
  Object.freeze({
    name: 'contract',
    quellPfad: 'packages/contract/src',
    zielPaket: 'packages/tcms-contract',
    ausschluesse: Object.freeze([]),
    beschreibung:
      'Exakte Kopie von packages/contract/src des TCMS-Repos ohne Tests. Nicht von Hand ändern: ' +
      'Aktualisieren mit scripts/tcms/sync-contract.mjs, Prüfung mit scripts/check-tcms-contract-vendor.mjs ' +
      '(docs/development/tcms-anbindung.md).',
  }),
  // Labels, Formatierung, Katalog und Profilregeln für die Oberflächen (TCMS
  // Stufe 3). Ohne audit.ts: die Hashkette (node:crypto) rechnet und prüft nur
  // der Dienst (Endpunkt auditPruefen); die kanzleikonsole zeigt das Ergebnis.
  Object.freeze({
    name: 'domain',
    quellPfad: 'packages/domain/src',
    zielPaket: 'packages/tcms-domain',
    ausschluesse: Object.freeze(['audit.ts']),
    beschreibung:
      'Exakte Kopie von packages/domain/src des TCMS-Repos ohne Tests und ohne audit.ts. Nicht von Hand ' +
      'ändern: Aktualisieren mit scripts/tcms/sync-contract.mjs --paket domain, Prüfung mit ' +
      'scripts/check-tcms-contract-vendor.mjs (docs/development/tcms-anbindung.md).',
  }),
]);

export const VENDOR_DATEI = 'VENDOR.json';

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Paket nach Kurzname oder `null`. */
export function vendorPaket(name) {
  return VENDOR_PAKETE.find((paket) => paket.name === name) ?? null;
}

/** Testdateien gehören nicht zur Kopie (`__tests__/`, `*.test.*`, `*.spec.*`). */
export function istTestdatei(pfad) {
  return (
    pfad.split('/').includes('__tests__') ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(posix.basename(pfad))
  );
}

/** Testdatei oder ausdrücklicher Ausschluss des Pakets: wird nicht kopiert. */
export function istAusgeschlossen(pfad, paket) {
  return istTestdatei(pfad) || paket.ausschluesse.includes(pfad);
}

/** Relativer POSIX-Pfad ohne leere, `.`- oder `..`-Segmente und ohne Sonderzeichen. */
export function istSichererPfad(pfad) {
  if (typeof pfad !== 'string' || pfad.length === 0 || pfad.length > 300) return false;
  return pfad
    .split('/')
    .every((segment) => segment !== '.' && segment !== '..' && SEGMENT.test(segment));
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Alle Einträge unter `wurzel`, rekursiv, als sortierte POSIX-Pfade. Symlinks
 * und andere Nicht-Dateien werden gemeldet statt verfolgt.
 */
export function listeEintraege(wurzel) {
  const dateien = [];
  const fremd = [];
  const besuche = (relativ) => {
    for (const name of readdirSync(join(wurzel, relativ)).sort()) {
      const pfad = relativ ? `${relativ}/${name}` : name;
      const info = lstatSync(join(wurzel, pfad));
      if (info.isDirectory()) besuche(pfad);
      else if (info.isFile()) dateien.push(pfad);
      else fremd.push(pfad);
    }
  };
  besuche('');
  return { dateien: dateien.sort(), fremd: fremd.sort() };
}

/** Prüft Aufbau und Werte von VENDOR.json für `paket`; liefert Befunde (leer = gültig). */
export function pruefeVendorDaten(daten, paket) {
  const befunde = [];
  if (!daten || typeof daten !== 'object' || Array.isArray(daten)) {
    return ['VENDOR.json ist kein Objekt'];
  }
  const schluessel = Object.keys(daten).sort().join(',');
  if (schluessel !== 'beschreibung,dateien,quelle') {
    befunde.push('VENDOR.json hat nicht genau die Felder beschreibung, quelle, dateien');
  }
  if (daten.beschreibung !== paket.beschreibung) {
    befunde.push(`beschreibung entspricht nicht dem Paket ${paket.name}`);
  }
  const q = daten.quelle;
  if (!q || typeof q !== 'object' || Object.keys(q).sort().join(',') !== 'commit,pfad,repo') {
    befunde.push('quelle hat nicht genau die Felder repo, pfad, commit');
  } else {
    if (!REPO.test(String(q.repo))) befunde.push('quelle.repo ist ungültig');
    if (q.pfad !== paket.quellPfad) befunde.push(`quelle.pfad muss ${paket.quellPfad} sein`);
    if (!COMMIT.test(String(q.commit))) befunde.push('quelle.commit ist kein vollständiger SHA-1');
  }
  if (!Array.isArray(daten.dateien) || daten.dateien.length === 0) {
    befunde.push('dateien ist leer oder keine Liste');
    return befunde;
  }
  let vorher = '';
  daten.dateien.forEach((eintrag, index) => {
    const nr = `dateien[${index}]`;
    if (
      !eintrag ||
      typeof eintrag !== 'object' ||
      Object.keys(eintrag).sort().join(',') !== 'pfad,sha256'
    ) {
      befunde.push(`${nr} hat nicht genau die Felder pfad, sha256`);
      return;
    }
    if (!istSichererPfad(eintrag.pfad)) befunde.push(`${nr}: unsicherer oder ungültiger Pfad`);
    else if (istTestdatei(eintrag.pfad)) befunde.push(`${nr}: Testdatei gehört nicht zur Kopie`);
    else if (paket.ausschluesse.includes(eintrag.pfad)) {
      befunde.push(`${nr}: ${eintrag.pfad} ist für ${paket.name} ausgeschlossen`);
    }
    if (!SHA256.test(String(eintrag.sha256))) befunde.push(`${nr}: sha256 ist ungültig`);
    if (typeof eintrag.pfad === 'string') {
      if (eintrag.pfad <= vorher) befunde.push(`${nr}: nicht aufsteigend sortiert oder doppelt`);
      vorher = eintrag.pfad;
    }
  });
  return befunde;
}

/**
 * Prüft ein Paketverzeichnis gegen sein VENDOR.json. Liefert Befunde als
 * Texte (Pfade relativ zu `src/`), nie Dateiinhalte.
 */
export function pruefeVendor(paketDir, paket) {
  const vendorPfad = join(paketDir, VENDOR_DATEI);
  if (!existsSync(vendorPfad)) return [`${VENDOR_DATEI} fehlt`];
  let daten;
  try {
    daten = JSON.parse(readFileSync(vendorPfad, 'utf8'));
  } catch {
    return [`${VENDOR_DATEI} ist kein gültiges JSON`];
  }
  const befunde = pruefeVendorDaten(daten, paket);
  if (befunde.length > 0) return befunde;

  const srcDir = join(paketDir, 'src');
  if (!existsSync(srcDir)) return ['src/ fehlt'];
  const { dateien, fremd } = listeEintraege(srcDir);
  for (const pfad of fremd) befunde.push(`src/${pfad}: weder Datei noch Verzeichnis (Symlink?)`);
  const erwartet = new Map(daten.dateien.map((eintrag) => [eintrag.pfad, eintrag.sha256]));
  for (const pfad of dateien) {
    const hash = erwartet.get(pfad);
    if (hash === undefined)
      befunde.push(`src/${pfad}: nicht in ${VENDOR_DATEI} (zusätzliche Datei)`);
    else if (sha256(readFileSync(join(srcDir, pfad))) !== hash) {
      befunde.push(`src/${pfad}: Inhalt weicht vom Quell-Commit ab (lokale Änderung)`);
    }
  }
  const vorhanden = new Set(dateien);
  for (const pfad of erwartet.keys()) {
    if (!vorhanden.has(pfad)) befunde.push(`src/${pfad}: fehlt`);
  }
  return befunde;
}
