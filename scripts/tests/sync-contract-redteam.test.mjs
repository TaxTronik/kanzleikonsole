// =============================================================================
// Red-Team (TCMS Stufe 2, Lieferkette / Angreifermodell F): Das Sync-Skript
// scripts/tcms/sync-contract.mjs folgt Symlinks im Quellbaum und uebernimmt
// deren DEREFERENZIERTEN Inhalt als regulaere Datei in den vendored Vertrag.
//
// Der Guard (scripts/check-tcms-contract-vendor.mjs) weist Symlinks in der
// KOPIE ausdruecklich ab ("weder Datei noch Verzeichnis (Symlink?)"), das
// Sync-Skript wendet dieselbe Regel aber NICHT auf die QUELLE an. Folge:
//   - Der vendored Inhalt weicht vom Git-Blob des aufgezeichneten
//     quelle.commit ab: `git show <commit>:packages/contract/src/<pfad>` liefert
//     fuer einen Symlink nur das Linkziel (z. B. "../../../geheim.txt"), die
//     Kopie enthaelt dagegen den dereferenzierten Inhalt.
//   - Der Guard akzeptiert die Kopie (der SHA-256 passt zu VENDOR.json), und ein
//     erneuter Sync auf denselben Commit erzeugt dieselben Bytes — die in
//     docs/development/tcms-anbindung.md beschriebene Pruefung "gegen die Quelle"
//     (git status leer nach erneutem Sync) schlaegt NICHT an.
//   - Der vendored Vertrag ist sicherheitskritisch (Signieren/Pruefen der
//     Akteursbestaetigung, striktes JSON, Anfragebindung). Ein boesartiger oder
//     kompromittierter Quellbaum kann damit Inhalt in die kanzleikonsole
//     schmuggeln, der sich der automatischen Pruefung UND einer Git-Blob-Sichtung
//     entzieht.
//
// Erwartung (sichere Soll-Lage): Das Sync-Skript lehnt eine Quelle mit einem
// Symlink unter packages/contract/src ab (wie der Guard in der Kopie) ODER
// uebernimmt hoechstens den Git-Blob (das Linkziel), nie den dereferenzierten
// Inhalt. Dieser Test scheitert, solange das Sync-Skript den Symlink
// dereferenziert; nach einer Behebung (Ablehnung bzw. Blob-treue Kopie) ist er
// gruen.
// =============================================================================
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SYNC = join(REPO_ROOT, 'scripts', 'tcms', 'sync-contract.mjs');
const temp = mkdtempSync(join(tmpdir(), 'tcms-sync-rt-'));
after(() => rmSync(temp, { recursive: true, force: true }));

function git(cwd, ...args) {
  const r = spawnSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.test',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

function schreibe(wurzel, pfad, inhalt) {
  mkdirSync(dirname(join(wurzel, pfad)), { recursive: true });
  writeFileSync(join(wurzel, pfad), inhalt);
}

function sync(quelle, ziel) {
  return spawnSync(process.execPath, [SYNC, '--from', quelle, '--ziel', ziel], {
    encoding: 'utf8',
  });
}

describe('sync-contract Lieferkette (Red Team, Modell F)', () => {
  test('dereferenziert keinen Symlink im Quellbaum in den vendored Vertrag', () => {
    const quelle = join(temp, 'symlink-quelle');
    mkdirSync(quelle);
    git(quelle, 'init', '-q', '-b', 'main');
    // Datei AUSSERHALB des Vertrags mit eindeutigem Inhalt.
    const geheim = 'GESCHMUGGELTER-INHALT-AUSSERHALB-DES-VERTRAGS\n';
    schreibe(quelle, 'geheim-ausserhalb.txt', geheim);
    schreibe(quelle, 'packages/contract/src/index.ts', 'export const echt = 1;\n');
    schreibe(quelle, 'packages/contract/package.json', '{}\n');
    // Getrackter Symlink UNTER dem Vertragspfad, der nach aussen zeigt.
    symlinkSync('../../../geheim-ausserhalb.txt', join(quelle, 'packages/contract/src/leck.ts'));
    git(quelle, 'add', '-A');
    git(quelle, 'commit', '-q', '-m', 'init');

    // Git speichert fuer den Symlink nur das Linkziel – das sieht ein Reviewer.
    const blob = git(quelle, 'show', 'HEAD:packages/contract/src/leck.ts');
    assert.equal(blob, '../../../geheim-ausserhalb.txt', 'Vorbedingung: Git-Blob ist das Linkziel');

    const ziel = join(temp, 'symlink-ziel');
    mkdirSync(ziel);
    const r = sync(quelle, ziel);

    // Sichere Soll-Lage: Entweder lehnt das Sync-Skript den Symlink ab, oder die
    // Kopie bleibt blob-treu (das Linkziel). In keinem Fall darf der
    // dereferenzierte Fremdinhalt in der Kopie landen.
    if (r.status === 0) {
      const kopie = readFileSync(join(ziel, 'src/leck.ts'), 'utf8');
      assert.notEqual(
        kopie,
        geheim,
        'Sync hat den Symlink dereferenziert und Fremdinhalt vendored (Lieferketten-Luecke RT2-K-01)',
      );
      // Zusatzbeleg: Die Kopie muss byte-genau dem auditierbaren Git-Blob des
      // aufgezeichneten Commits entsprechen.
      const commit = JSON.parse(readFileSync(join(ziel, 'VENDOR.json'), 'utf8')).quelle.commit;
      const blobBeiCommit = git(quelle, 'show', `${commit}:packages/contract/src/leck.ts`);
      assert.equal(kopie, blobBeiCommit, 'Vendored Datei weicht vom Git-Blob des Commits ab');
    }
  });
});
