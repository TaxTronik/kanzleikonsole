// =============================================================================
// RT3B-K-02: Prisma 7 kann eine Ergebnisspalte vom Typ `void` nicht lesen
// („Failed to deserialize column of type 'void'“). `$queryRaw` mit
// `SELECT app.<void-Funktion>(…)` scheitert deshalb auch dann, wenn die
// Funktion fehlerfrei durchläuft – so blockierte der Claim
// app.assert_gwg_document_destruction_due jede GwG-Pflichtvernichtung, und ein
// Test, der eine Ablehnung erwartet, bliebe auch ohne Ablehnung grün.
//
// Guard über das ganze Repository: Jeder Aufruf einer Funktion, die laut
// kanonischer Quelle (packages/db/prisma/sql/functions) `void` liefert, läuft
// über `$executeRaw` oder liest das Ergebnis mit `::text`. Die Proben belegen,
// dass die Erkennung greift.
// =============================================================================

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const FUNKTIONEN = join(REPO, 'packages/db/prisma/sql/functions');
const WURZELN = ['apps', 'packages', 'scripts'];
const AUSGENOMMEN = new Set(['node_modules', '.next', 'dist', 'build', 'coverage', 'prisma']);
const ENDUNGEN = /\.(?:[cm]?[jt]sx?)$/;

/** `schema.name` aller Funktionen mit `RETURNS void` (kanonische Quellen). */
export function voidFunktionen(): string[] {
  return readdirSync(FUNKTIONEN)
    .filter((datei) => /^ RETURNS void$/m.test(readFileSync(join(FUNKTIONEN, datei), 'utf8')))
    .map((datei) => datei.replace(/\(.*$/, ''));
}

/** Index hinter dem Literal, das bei `start` beginnt (`, ' oder "), oder -1. */
function literalEnde(code: string, start: number): number {
  const zeichen = code[start];
  let i = start + 1;
  while (i < code.length) {
    const c = code[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (zeichen === '`' && c === '$' && code[i + 1] === '{') {
      let tiefe = 1;
      i += 2;
      while (i < code.length && tiefe > 0) {
        if (code[i] === '{') tiefe += 1;
        else if (code[i] === '}') tiefe -= 1;
        i += 1;
      }
      continue;
    }
    if (c === zeichen) return i + 1;
    i += 1;
  }
  return -1;
}

/** Ersetzt `${…}` eines Template-Literals durch einen Platzhalter (wie Prisma: `?`). */
function ohneAusdruecke(literal: string): string {
  let ergebnis = '';
  for (let i = 0; i < literal.length; i += 1) {
    if (literal[i] === '$' && literal[i + 1] === '{') {
      let tiefe = 1;
      i += 2;
      while (i < literal.length && tiefe > 0) {
        if (literal[i] === '{') tiefe += 1;
        else if (literal[i] === '}') tiefe -= 1;
        i += 1;
      }
      i -= 1;
      ergebnis += '?';
    } else {
      ergebnis += literal[i];
    }
  }
  return ergebnis;
}

/** SQL des ersten Literals hinter einem `$queryRaw`/`$queryRawUnsafe` (Typargument übersprungen). */
function sqlNach(code: string, ab: number): string | null {
  let i = ab;
  while (/\s/.test(code[i] ?? '')) i += 1;
  if (code[i] === '<') {
    let tiefe = 0;
    for (; i < code.length; i += 1) {
      if (code[i] === '<') tiefe += 1;
      else if (code[i] === '>' && code[i - 1] !== '=') {
        tiefe -= 1;
        if (tiefe === 0) {
          i += 1;
          break;
        }
      }
    }
  }
  // Nur ein Literal unmittelbar als Argument (`…`, ('…'), (Prisma.sql`…`)); eine
  // Erwähnung in einem Kommentar ist kein Aufruf.
  const kopf = /^\s*(?:\(\s*(?:Prisma\s*\.\s*sql\s*)?)?(?=[`'"])/.exec(code.slice(i, i + 200));
  if (!kopf) return null;
  const start = i + kopf[0].length;
  const ende = literalEnde(code, start);
  return ende < 0 ? null : ohneAusdruecke(code.slice(start + 1, ende - 1));
}

/** Aufrufe von void-Funktionen per `$queryRaw` ohne `::text` in einem Quelltext. */
export function voidLesezugriffe(code: string, funktionen: readonly string[]): string[] {
  const treffer: string[] = [];
  for (const aufruf of code.matchAll(/\$queryRaw(?:Unsafe)?\b/g)) {
    const roh = sqlNach(code, (aufruf.index ?? 0) + aufruf[0].length);
    if (!roh) continue;
    // SQL-Zeichenketten sind kein Aufruf (z. B. '…(uuid)'::regprocedure).
    const sql = roh.replace(/'(?:[^']|'')*'/g, "''");
    for (const f of sql.matchAll(/\b(app|public)\s*\.\s*(\w+)\s*\(/g)) {
      const name = `${f[1]}.${f[2]}`;
      if (!funktionen.includes(name)) continue;
      let tiefe = 1;
      let i = (f.index ?? 0) + f[0].length;
      for (; i < sql.length && tiefe > 0; i += 1) {
        if (sql[i] === '(') tiefe += 1;
        else if (sql[i] === ')') tiefe -= 1;
      }
      if (!/^\s*::\s*text\b/i.test(sql.slice(i))) treffer.push(name);
    }
  }
  return treffer;
}

function dateien(verzeichnis: string): string[] {
  const ergebnis: string[] = [];
  for (const name of readdirSync(verzeichnis)) {
    if (AUSGENOMMEN.has(name)) continue;
    const pfad = join(verzeichnis, name);
    if (statSync(pfad).isDirectory()) ergebnis.push(...dateien(pfad));
    else if (ENDUNGEN.test(name)) ergebnis.push(pfad);
  }
  return ergebnis;
}

describe('void-Funktionen nie per $queryRaw lesen (RT3B-K-02)', () => {
  const VOID = voidFunktionen();

  it('kennt die void-Funktionen aus den kanonischen SQL-Quellen', () => {
    expect(VOID).toContain('app.assert_gwg_document_destruction_due');
    expect(VOID).toContain('app.settle_storage_intent');
  });

  it('Proben: erkennt jeden ungeschützten Lesezugriff und lässt $executeRaw und ::text zu', () => {
    const f = ['app.f'];
    expect(voidLesezugriffe('await tx.$queryRaw`SELECT app.f(${id}::uuid)`;', f)).toEqual([
      'app.f',
    ]);
    expect(
      voidLesezugriffe('await tx.$queryRaw(\n  Prisma.sql`SELECT app.f(${id}::uuid)`,\n);', f),
    ).toEqual(['app.f']);
    expect(
      voidLesezugriffe("await tx.$queryRaw<Array<{ s: 'A' | 'B' }>>`SELECT app.f(${id}) AS x`;", f),
    ).toEqual(['app.f']);
    expect(voidLesezugriffe("await tx.$queryRawUnsafe('SELECT app.f($1)', id);", f)).toEqual([
      'app.f',
    ]);
    expect(voidLesezugriffe('await tx.$queryRaw`SELECT app.f(${a(b)}, lower(x))`;', f)).toEqual([
      'app.f',
    ]);
    expect(
      voidLesezugriffe('await tx.$queryRaw`SELECT app.f(${id}::uuid)::text AS x`;', f),
    ).toEqual([]);
    expect(voidLesezugriffe('await tx.$queryRaw`SELECT app.f(${id})::TEXT AS "x"`;', f)).toEqual(
      [],
    );
    expect(voidLesezugriffe('await tx.$executeRaw`SELECT app.f(${id}::uuid)`;', f)).toEqual([]);
    expect(voidLesezugriffe('await tx.$queryRaw`SELECT app.g(${id}::uuid)`;', f)).toEqual([]);
    expect(
      voidLesezugriffe("await p.$queryRaw`SELECT 'app.f(uuid)'::regprocedure AS oid`;", f),
    ).toEqual([]);
    expect(
      voidLesezugriffe('// nicht per $queryRaw\nawait tx.$executeRaw`SELECT app.f(${id})`;', f),
    ).toEqual([]);
  });

  it('kein Aufruf im Repository liest eine void-Funktion per $queryRaw', () => {
    const verstoesse: string[] = [];
    for (const wurzel of WURZELN) {
      for (const datei of dateien(join(REPO, wurzel))) {
        const code = readFileSync(datei, 'utf8');
        if (!code.includes('$queryRaw')) continue;
        for (const name of voidLesezugriffe(code, VOID)) {
          verstoesse.push(`${relative(REPO, datei).split(sep).join('/')}: ${name}`);
        }
      }
    }
    expect(verstoesse).toEqual([]);
  });
});
