import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkDocLinks } from '../check-doc-links.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'taxtronik-doc-links-'));
  mkdirSync(join(root, 'docs', 'bereich'), { recursive: true });
  writeFileSync(
    join(root, 'README.md'),
    '# Einstieg\n\n[Kapitel](docs/bereich/kapitel.md#übersicht)\n',
  );
  writeFileSync(join(root, 'docs', 'bereich', 'kapitel.md'), '# Übersicht\n');
  return root;
}

test('akzeptiert vorhandene lokale Datei und Unicode-Anker', () => {
  const root = fixture();
  try {
    assert.deepEqual(checkDocLinks(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('meldet fehlende Ziele und Anker', () => {
  const root = fixture();
  try {
    writeFileSync(
      join(root, 'README.md'),
      '# Einstieg\n\n[Datei](docs/fehlt.md) [Anker](docs/bereich/kapitel.md#fehlt)\n',
    );
    const errors = checkDocLinks(root);
    assert.equal(errors.length, 2);
    assert.match(errors[0], /Ziel fehlt/);
    assert.match(errors[1], /Anker fehlt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ignoriert externe Links und Links in Codeblöcken', () => {
  const root = fixture();
  try {
    writeFileSync(
      join(root, 'README.md'),
      '# Einstieg\n\n[IDW](https://www.idw.de/)\n\n```md\n[Beispiel](fehlt.md)\n```\n',
    );
    assert.deepEqual(checkDocLinks(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verarbeitet in spitzen Klammern geschützte Pfade mit runden Klammern', () => {
  const root = fixture();
  try {
    mkdirSync(join(root, 'docs', '(intern)'), { recursive: true });
    writeFileSync(join(root, 'docs', '(intern)', 'datei.md'), '# Intern\n');
    writeFileSync(join(root, 'README.md'), '[Intern](<docs/(intern)/datei.md>)\n');
    assert.deepEqual(checkDocLinks(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
