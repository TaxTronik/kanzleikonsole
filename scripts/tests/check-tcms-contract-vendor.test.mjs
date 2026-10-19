// Regressionstests für den vendored TCMS-Vertrag (TCMS Stufe 2):
// scripts/tcms/sync-contract.mjs und scripts/check-tcms-contract-vendor.mjs.
// Jede Regel des Guards hat einen Fall, der ohne die Regel durchginge.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pruefeTcmsVertrag } from '../check-tcms-contract-vendor.mjs';
import {
  istSichererPfad,
  istTestdatei,
  pruefeVendor,
  pruefeVendorDaten,
} from '../tcms/vendor-lib.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SYNC = join(REPO_ROOT, 'scripts', 'tcms', 'sync-contract.mjs');
const temp = mkdtempSync(join(tmpdir(), 'tcms-vendor-'));
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
  return r.stdout.trim();
}

function schreibe(wurzel, pfad, inhalt) {
  mkdirSync(dirname(join(wurzel, pfad)), { recursive: true });
  writeFileSync(join(wurzel, pfad), inhalt);
}

/** Kleines TCMS-Repo mit Vertrag, Tests und einer Datei außerhalb des Vertrags. */
function quellRepo(name) {
  const wurzel = join(temp, name);
  mkdirSync(wurzel);
  git(wurzel, 'init', '-q', '-b', 'main');
  schreibe(wurzel, 'packages/contract/src/index.ts', "export * from './akteur';\n");
  schreibe(wurzel, 'packages/contract/src/akteur.ts', 'export const A = 1;\n');
  schreibe(wurzel, 'packages/contract/src/bereiche/lesen.ts', 'export const L = 2;\n');
  schreibe(wurzel, 'packages/contract/src/bereiche/lesen.test.ts', 'test\n');
  schreibe(wurzel, 'packages/contract/src/__tests__/akteur.test.ts', 'test\n');
  schreibe(wurzel, 'packages/contract/package.json', '{}\n');
  schreibe(wurzel, 'README.md', 'tcms\n');
  git(wurzel, 'add', '-A');
  git(wurzel, 'commit', '-q', '-m', 'init');
  return wurzel;
}

function sync(quelle, ziel) {
  return spawnSync(process.execPath, [SYNC, '--from', quelle, '--ziel', ziel], {
    encoding: 'utf8',
  });
}

function gueltigesPaket(name) {
  const quelle = quellRepo(`${name}-quelle`);
  const ziel = join(temp, `${name}-ziel`);
  mkdirSync(ziel);
  const r = sync(quelle, ziel);
  assert.equal(r.status, 0, r.stderr);
  return { quelle, ziel };
}

describe('sync-contract', () => {
  test('kopiert den Vertrag ohne Tests und schreibt Quell-Commit und Hashes', () => {
    const { quelle, ziel } = gueltigesPaket('kopie');
    const vendor = JSON.parse(readFileSync(join(ziel, 'VENDOR.json'), 'utf8'));
    assert.equal(vendor.quelle.commit, git(quelle, 'rev-parse', 'HEAD'));
    assert.equal(vendor.quelle.pfad, 'packages/contract/src');
    assert.deepEqual(
      vendor.dateien.map((d) => d.pfad),
      ['akteur.ts', 'bereiche/lesen.ts', 'index.ts'],
    );
    assert.equal(existsSync(join(ziel, 'src/__tests__')), false);
    assert.equal(existsSync(join(ziel, 'src/bereiche/lesen.test.ts')), false);
    assert.deepEqual(pruefeVendor(ziel), []);
  });

  test('entfernt im Ziel Dateien, die es in der Quelle nicht mehr gibt', () => {
    const { quelle, ziel } = gueltigesPaket('aufraeumen');
    schreibe(ziel, 'src/alt.ts', 'alt\n');
    assert.equal(sync(quelle, ziel).status, 0);
    assert.equal(existsSync(join(ziel, 'src/alt.ts')), false);
    assert.deepEqual(pruefeVendor(ziel), []);
  });

  test('verweigert bei geänderten oder unversionierten Dateien im Quellbaum', () => {
    const { quelle, ziel } = gueltigesPaket('schmutzig');
    const vorher = readFileSync(join(ziel, 'VENDOR.json'), 'utf8');
    schreibe(quelle, 'packages/contract/src/akteur.ts', 'export const A = 99;\n');
    let r = sync(quelle, ziel);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ungesicherte Änderungen/);
    git(quelle, 'checkout', '--', '.');
    schreibe(quelle, 'packages/contract/src/neu.ts', 'neu\n');
    r = sync(quelle, ziel);
    assert.equal(r.status, 1);
    // Weder Kopie noch VENDOR.json wurden angefasst.
    assert.equal(readFileSync(join(ziel, 'VENDOR.json'), 'utf8'), vorher);
    assert.equal(existsSync(join(ziel, 'src/neu.ts')), false);
  });

  test('verweigert Symlinks und ausführbare Dateien im Vertrag (RT2-K-01)', () => {
    for (const art of ['symlink', 'ausfuehrbar']) {
      const { quelle, ziel } = gueltigesPaket(`modus-${art}`);
      const vorher = readFileSync(join(ziel, 'VENDOR.json'), 'utf8');
      if (art === 'symlink') {
        symlinkSync('../../../README.md', join(quelle, 'packages/contract/src/leck.ts'));
      } else {
        chmodSync(join(quelle, 'packages/contract/src/akteur.ts'), 0o755);
      }
      git(quelle, 'add', '-A');
      git(quelle, 'commit', '-q', '-m', art);
      const r = sync(quelle, ziel);
      assert.equal(r.status, 1, art);
      assert.match(r.stderr, /keine normale Datei/);
      // Die Prüfung läuft vor jedem Schreibzugriff.
      assert.equal(readFileSync(join(ziel, 'VENDOR.json'), 'utf8'), vorher);
      assert.deepEqual(pruefeVendor(ziel), []);
    }
  });

  test('übernimmt den Git-Blob des Commits, nie den Arbeitsbaum (RT2-K-01)', () => {
    // skip-worktree versteckt eine Änderung vor `git status`; gelesen werden
    // darf trotzdem nur der Blob des aufgezeichneten Commits.
    const quelle = quellRepo('blob-treu-quelle');
    git(quelle, 'update-index', '--skip-worktree', 'packages/contract/src/akteur.ts');
    schreibe(quelle, 'packages/contract/src/akteur.ts', 'export const A = 666;\n');
    assert.equal(git(quelle, 'status', '--porcelain=v1'), '');
    const ziel = join(temp, 'blob-treu-ziel');
    mkdirSync(ziel);
    const r = sync(quelle, ziel);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(ziel, 'src/akteur.ts'), 'utf8'), 'export const A = 1;\n');
  });

  test('verweigert ohne Git-Checkout und ohne --from', () => {
    const leer = join(temp, 'kein-git');
    mkdirSync(leer);
    assert.equal(sync(leer, join(temp, 'egal')).status, 1);
    const r = spawnSync(process.execPath, [SYNC], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--from/);
  });
});

describe('check-tcms-contract-vendor', () => {
  test('der eingecheckte Vertrag entspricht VENDOR.json', () => {
    assert.deepEqual(pruefeTcmsVertrag(REPO_ROOT), []);
  });

  test('meldet lokale Änderung, zusätzliche und fehlende Dateien', () => {
    const { ziel } = gueltigesPaket('abweichung');
    schreibe(ziel, 'src/akteur.ts', 'export const A = 2;\n');
    assert.deepEqual(pruefeVendor(ziel), [
      'src/akteur.ts: Inhalt weicht vom Quell-Commit ab (lokale Änderung)',
    ]);
    schreibe(ziel, 'src/akteur.ts', 'export const A = 1;\n');
    schreibe(ziel, 'src/bereiche/extra.ts', 'x\n');
    assert.deepEqual(pruefeVendor(ziel), [
      'src/bereiche/extra.ts: nicht in VENDOR.json (zusätzliche Datei)',
    ]);
    rmSync(join(ziel, 'src/bereiche'), { recursive: true });
    assert.deepEqual(pruefeVendor(ziel), ['src/bereiche/lesen.ts: fehlt']);
  });

  test('meldet zusätzliche Dotfiles und Symlinks', () => {
    const { ziel } = gueltigesPaket('versteckt');
    schreibe(ziel, 'src/.versteckt', 'x\n');
    assert.match(pruefeVendor(ziel).join('\n'), /src\/\.versteckt: nicht in VENDOR\.json/);
    rmSync(join(ziel, 'src/.versteckt'));
    symlinkSync(join(ziel, 'src/akteur.ts'), join(ziel, 'src/link.ts'));
    assert.match(pruefeVendor(ziel).join('\n'), /src\/link\.ts: weder Datei noch Verzeichnis/);
  });

  test('weist fehlendes, kaputtes oder manipuliertes VENDOR.json ab', () => {
    const { ziel } = gueltigesPaket('vendor');
    const vendorPfad = join(ziel, 'VENDOR.json');
    const gut = JSON.parse(readFileSync(vendorPfad, 'utf8'));
    writeFileSync(vendorPfad, '{');
    assert.deepEqual(pruefeVendor(ziel), ['VENDOR.json ist kein gültiges JSON']);
    rmSync(vendorPfad);
    assert.deepEqual(pruefeVendor(ziel), ['VENDOR.json fehlt']);
    // Ein gefälschter Hash zu einer geänderten Datei fällt über den Inhalt auf,
    // eine Datei ohne Eintrag über den Abgleich der Dateimenge.
    const ohneEintrag = { ...gut, dateien: gut.dateien.filter((d) => d.pfad !== 'akteur.ts') };
    writeFileSync(vendorPfad, JSON.stringify(ohneEintrag));
    assert.deepEqual(pruefeVendor(ziel), [
      'src/akteur.ts: nicht in VENDOR.json (zusätzliche Datei)',
    ]);
  });

  test('prüft Aufbau und Werte von VENDOR.json', () => {
    const basis = {
      beschreibung: 'x',
      quelle: { repo: 'tcms', pfad: 'packages/contract/src', commit: 'a'.repeat(40) },
      dateien: [
        { pfad: 'a.ts', sha256: 'b'.repeat(64) },
        { pfad: 'b/c.ts', sha256: 'c'.repeat(64) },
      ],
    };
    assert.deepEqual(pruefeVendorDaten(basis), []);
    const fall = (aenderung) => pruefeVendorDaten({ ...basis, ...aenderung });
    assert.match(fall({ zusatz: 1 }).join(), /genau die Felder/);
    assert.match(fall({ quelle: { ...basis.quelle, commit: 'abc' } }).join(), /SHA-1/);
    assert.match(fall({ quelle: { ...basis.quelle, pfad: 'src' } }).join(), /quelle\.pfad/);
    assert.match(fall({ dateien: [] }).join(), /leer/);
    for (const pfad of ['../x.ts', '/abs.ts', 'a//b.ts', './a.ts', 'a\\b.ts', 'a b.ts']) {
      assert.match(
        fall({ dateien: [{ pfad, sha256: 'b'.repeat(64) }] }).join(),
        /unsicherer/,
        pfad,
      );
    }
    assert.match(
      fall({ dateien: [{ pfad: '__tests__/a.ts', sha256: 'b'.repeat(64) }] }).join(),
      /Testdatei/,
    );
    assert.match(
      fall({ dateien: [{ pfad: 'a.ts', sha256: 'XYZ' }] }).join(),
      /sha256 ist ungültig/,
    );
    assert.match(
      fall({ dateien: [...basis.dateien].reverse() }).join(),
      /nicht aufsteigend sortiert/,
    );
    assert.match(
      fall({ dateien: [basis.dateien[0], basis.dateien[0]] }).join(),
      /nicht aufsteigend sortiert oder doppelt/,
    );
  });

  test('erkennt Testdateien und sichere Pfade', () => {
    assert.equal(istTestdatei('__tests__/a.ts'), true);
    assert.equal(istTestdatei('bereiche/x.test.ts'), true);
    assert.equal(istTestdatei('bereiche/x.spec.mjs'), true);
    assert.equal(istTestdatei('bereiche/testen.ts'), false);
    assert.equal(istSichererPfad('bereiche/lesepfade.ts'), true);
    assert.equal(istSichererPfad('..'), false);
    assert.equal(istSichererPfad(''), false);
  });
});
