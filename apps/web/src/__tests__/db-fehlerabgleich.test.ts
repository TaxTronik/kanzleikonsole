// =============================================================================
// Guard: In DB-Suiten wird ein abgewiesener Aufruf nur über die Angaben der
// Datenbank geprüft (TCMS Stufe 3, kk-tcms-qual; Nebenbefund TCMS s7).
//
// Prisma hängt an die Meldung eines Fehlers einen Codeausschnitt der
// aufrufenden Stelle (Quellpfad, die Zeilen davor, den Aufruf). Ein
// `rejects.toThrow(/Muster/)`, `toThrowError`, ein Abgleich auf `e.message` oder
// `String(e)` besteht deshalb auch dann, wenn das Muster nur in diesem
// Ausschnitt steht – etwa im Muster der Zeile davor. Eine gebrochene Trigger-,
// RLS- oder CHECK-Regel bliebe so grün.
//
// Erlaubt sind in DB-Suiten nur die Helfer aus
// packages/db/src/testing/db-fehler.ts (`dbAbgewiesen`, `erwarteDbFehler` für
// SQLSTATE, Meldung und Bedingung der Datenbank; `anwendungAbgewiesen`,
// `erwarteAnwendungsfehler` für Fehler der Anwendung, die Datenbankfehler
// zurückweisen) sowie strukturierte Prüfungen (`toBeInstanceOf`,
// `toMatchObject({ code })`). Synchrones `expect(() => …).toThrow(…)` bleibt
// erlaubt: Prisma und node-postgres scheitern nie synchron.
//
// DB-Suiten: jede `*-db.test.ts(x)` (scripts/ci/db-suites.mjs), die ganze
// Suite von @taxtronik/db und die Live-Suiten (`*-live.test.ts(x)`, echte
// Datenbank und echter Dienst). Ausnahmen stehen begründet in ERLAUBT; ein
// Eintrag ohne Treffer lässt den Guard scheitern.
// =============================================================================

import { globSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { DB_PACKAGE, findDbSuites } from '../../../../scripts/ci/db-suites.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

export type Regel =
  /** `.rejects.toThrow*(…)`, auch ohne Muster (prüft keinen Grund). */
  | 'rejects-toThrow'
  /** Matcher hinter `.rejects`, der die Meldung prüft. */
  | 'rejects-meldung'
  /** `e.message` eines Fehlers. */
  | 'fehler-meldung'
  /** `String(e)`, `` `${e}` `` oder `e.toString()` eines Fehlers. */
  | 'fehler-text'
  /** `expect(e).toMatchObject({ message })` u. ä. auf einem Fehler. */
  | 'fehler-objekt'
  /** `dbAbgewiesen(…)`/`anwendungAbgewiesen(…)` ohne `await`: prüft nichts. */
  | 'nicht-abgewartet';

export interface Verstoss {
  regel: Regel;
  zeile: number;
  auszug: string;
}

/** Variablen, die einen gefangenen Fehler tragen. */
const FEHLER_VARIABLE =
  /^(?:e|err|error|ex|exception|fehler|failure|caught|rejection|ablehnung)$|(?:Error|Fehler|Failure|Rejection|Ablehnung)$/;
/** Eigenschaften, die einen Fehler tragen (`result.reason` aus allSettled, `x.error`). */
const FEHLER_EIGENSCHAFT = /^(?:reason|error|fehler|failure)$|(?:Error|Fehler|Failure|Reason)$/;

/** Asynchrone Helfer aus @taxtronik/db/testing/db-fehler. */
const ASYNC_HELFER = new Set(['dbAbgewiesen', 'anwendungAbgewiesen']);

const MELDUNGS_MATCHER = new Set([
  'toMatch',
  'toContain',
  'toBe',
  'toEqual',
  'toStrictEqual',
  'toMatchObject',
  'toHaveProperty',
  'toMatchInlineSnapshot',
  'toMatchSnapshot',
]);

function ohneHuelle(knoten: ts.Expression): ts.Expression {
  let k = knoten;
  for (;;) {
    if (ts.isParenthesizedExpression(k) || ts.isAsExpression(k) || ts.isNonNullExpression(k)) {
      k = k.expression;
    } else if (ts.isTypeAssertionExpression(k) || ts.isSatisfiesExpression(k)) {
      k = k.expression;
    } else {
      return k;
    }
  }
}

/**
 * Ausdruck, der einen Fehler trägt: `e`, `(error as Error)`, `result.reason`,
 * `sent[0].reason`; mit `mitAwait` auch `await p` (z. B. `String(await p)` auf
 * ein `p.catch((e) => e)`).
 */
function istFehlerAusdruck(knoten: ts.Expression, mitAwait = false): boolean {
  const k = ohneHuelle(knoten);
  if (ts.isAwaitExpression(k)) return mitAwait;
  if (ts.isIdentifier(k)) return FEHLER_VARIABLE.test(k.text);
  if (ts.isPropertyAccessExpression(k)) return FEHLER_EIGENSCHAFT.test(k.name.text);
  if (ts.isElementAccessExpression(k)) return istFehlerAusdruck(k.expression);
  return false;
}

function istExpect(aufruf: ts.CallExpression): boolean {
  const name = ohneHuelle(aufruf.expression);
  return (
    (ts.isIdentifier(name) && name.text === 'expect') ||
    (ts.isPropertyAccessExpression(name) &&
      ts.isIdentifier(name.expression) &&
      name.expression.text === 'expect')
  );
}

/** `expect(…)`-Aufruf am Anfang einer Matcher-Kette und ob `.rejects` darin steht. */
function matcherKette(
  aufruf: ts.CallExpression,
): { expectAufruf: ts.CallExpression; rejects: boolean; matcher: string } | null {
  if (!ts.isPropertyAccessExpression(aufruf.expression)) return null;
  const matcher = aufruf.expression.name.text;
  let k: ts.Expression = aufruf.expression.expression;
  let rejects = false;
  while (ts.isPropertyAccessExpression(k)) {
    if (k.name.text === 'rejects') rejects = true;
    k = k.expression;
  }
  if (!ts.isCallExpression(k) || !istExpect(k)) return null;
  return { expectAufruf: k, rejects, matcher };
}

function erwaehntMeldung(argumente: readonly ts.Expression[]): boolean {
  return argumente.some((argument) => /\bmessage\b/.test(argument.getText()));
}

/** Regel eines Matcher-Aufrufs `expect(…)[.rejects].matcher(…)`, sonst `null`. */
function matcherRegel(aufruf: ts.CallExpression): Regel | null {
  const kette = matcherKette(aufruf);
  if (!kette) return null;
  if (kette.rejects) {
    if (kette.matcher.startsWith('toThrow')) return 'rejects-toThrow';
    return erwaehntMeldung(aufruf.arguments) ? 'rejects-meldung' : null;
  }
  const wert = kette.expectAufruf.arguments[0];
  const aufFehler =
    MELDUNGS_MATCHER.has(kette.matcher) && wert !== undefined && istFehlerAusdruck(wert, true);
  return aufFehler && erwaehntMeldung(aufruf.arguments) ? 'fehler-objekt' : null;
}

/** Regel eines sonstigen Aufrufs: Helfer ohne `await`, `String(e)`, `e.toString()`. */
function aufrufRegel(aufruf: ts.CallExpression): Regel | null {
  const name = ohneHuelle(aufruf.expression);
  if (ts.isIdentifier(name)) {
    if (ASYNC_HELFER.has(name.text) && ts.isExpressionStatement(aufruf.parent)) {
      return 'nicht-abgewartet';
    }
    const argument = aufruf.arguments[0];
    if (name.text === 'String' && argument !== undefined && istFehlerAusdruck(argument, true)) {
      return 'fehler-text';
    }
  }
  if (
    ts.isPropertyAccessExpression(name) &&
    name.name.text === 'toString' &&
    istFehlerAusdruck(name.expression)
  ) {
    return 'fehler-text';
  }
  return null;
}

/** Verstöße einer Datei gegen den Abgleich auf Datenbankfehler. */
export function abgleichVerstoesse(datei: string, code: string): Verstoss[] {
  const art = datei.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const quelle = ts.createSourceFile(datei, code, ts.ScriptTarget.Latest, true, art);
  const treffer: Verstoss[] = [];
  const melde = (regel: Regel | null, knoten: ts.Node) => {
    if (regel === null) return;
    const zeile = quelle.getLineAndCharacterOfPosition(knoten.getStart(quelle)).line + 1;
    treffer.push({
      regel,
      zeile,
      auszug: knoten.getText(quelle).replace(/\s+/g, ' ').slice(0, 120),
    });
  };
  const besuche = (knoten: ts.Node): void => {
    if (ts.isCallExpression(knoten)) {
      melde(matcherRegel(knoten), knoten);
      melde(aufrufRegel(knoten), knoten);
    }
    if (ts.isTemplateExpression(knoten)) {
      for (const teil of knoten.templateSpans) {
        if (istFehlerAusdruck(teil.expression)) melde('fehler-text', teil.expression);
      }
    }
    const istMeldung =
      ts.isPropertyAccessExpression(knoten) &&
      knoten.name.text === 'message' &&
      istFehlerAusdruck(knoten.expression);
    if (istMeldung) melde('fehler-meldung', knoten);
    // Der Hinweis von `expect(wert, hinweis)` ist nur Ausgabe, kein Abgleich.
    if (ts.isCallExpression(knoten) && istExpect(knoten) && knoten.arguments.length > 1) {
      besuche(knoten.expression);
      besuche(knoten.arguments[0]!);
      return;
    }
    ts.forEachChild(knoten, besuche);
  };
  besuche(quelle);
  return treffer;
}

/** DB-Suiten relativ zum Repository (Schrägstriche), sortiert. */
export function dbSuiten(root: string): string[] {
  const posix = (pfad: string) => pfad.split(sep).join('/');
  const dateien = new Set<string>(findDbSuites(root));
  for (const datei of globSync(`${DB_PACKAGE.dir}/src/**/*.test.{ts,tsx}`, { cwd: root })) {
    dateien.add(posix(datei));
  }
  for (const datei of globSync('apps/*/src/**/*-live.test.{ts,tsx}', { cwd: root })) {
    dateien.add(posix(datei));
  }
  return [...dateien].sort();
}

interface Ausnahme {
  datei: string;
  regel: Regel;
  /** Teil des Auszugs, der genau diese Stelle trifft. */
  auszug: string;
  grund: string;
}

const ERLAUBT: readonly Ausnahme[] = [
  {
    datei: 'packages/db/src/__tests__/db-fehler.test.ts',
    regel: 'rejects-toThrow',
    auszug: 'rejects.toThrow(/Vernichtungsclaim eingefroren/)',
    grund:
      'Regressionsnachweis der Falle selbst: das Muster steht nur im Prisma-Codeausschnitt, der alte Abgleich besteht, dbAbgewiesen scheitert.',
  },
  {
    datei: 'apps/web/src/server/invoicing/__tests__/invoice-concurrency-db.test.ts',
    regel: 'fehler-meldung',
    auszug: '(error as Error).message',
    grund:
      'Nachbau von staffAction im Mock: gibt nur Meldungen der Anwendung als ActionResult weiter; Datenbankfehler erscheinen als SQLSTATE (dbFehler), nie mit Prisma-Text.',
  },
];

describe('Guard: Abgleich auf Datenbankfehler in DB-Suiten (kk-tcms-qual)', () => {
  it('erkennt jede verbotene Form (Proben)', () => {
    const proben: Array<[string, Regel]> = [
      ['await expect(p).rejects.toThrow(/x/);', 'rejects-toThrow'],
      ['await expect(p).rejects.toThrow();', 'rejects-toThrow'],
      ["await expect(p).rejects.toThrowError('x');", 'rejects-toThrow'],
      ['await expect(async () => f()).rejects.toThrow(/x/);', 'rejects-toThrow'],
      ['await expect(p).rejects.not.toThrow();', 'rejects-toThrow'],
      ["await expect(p).rejects.toMatchObject({ message: 'x' });", 'rejects-meldung'],
      ["await expect(p).rejects.toHaveProperty('message', 'x');", 'rejects-meldung'],
      ['expect((error as Error).message).toMatch(/x/);', 'fehler-meldung'],
      ['const m = await p.catch((e: Error) => e.message);', 'fehler-meldung'],
      ['expect(result.reason.message).toContain("x");', 'fehler-meldung'],
      ['expect(String(directCancelFailure)).toMatch(/x/);', 'fehler-text'],
      ['expect(String(sent[0].reason)).toMatch(/x/);', 'fehler-text'],
      ['expect(String(await second)).toMatch(/x/);', 'fehler-text'],
      ['expect(`${fehler}`).toMatch(/x/);', 'fehler-text'],
      ['expect(error.toString()).toMatch(/x/);', 'fehler-text'],
      ['expect(error).toMatchObject({ message: expect.stringMatching(/x/) });', 'fehler-objekt'],
      ['dbAbgewiesen(p, /x/);', 'nicht-abgewartet'],
      ['anwendungAbgewiesen(p, /x/);', 'nicht-abgewartet'],
    ];
    for (const [code, regel] of proben) {
      expect(
        abgleichVerstoesse('probe-db.test.ts', code).map((v) => v.regel),
        code,
      ).toContain(regel);
    }
  });

  it('lässt die Helfer und strukturierte Prüfungen zu', () => {
    const erlaubt = [
      'await dbAbgewiesen(p, { sqlState: "42501", meldung: /x/ });',
      'await anwendungAbgewiesen(p, /x/);',
      'await Promise.all([dbAbgewiesen(p, /x/), dbAbgewiesen(q, /y/)]);',
      'return dbAbgewiesen(p, /x/);',
      'erwarteDbFehler(result.reason, /x/);',
      'const m = await p.catch((e: unknown) => erwarteAnwendungsfehler(e, /x/).message);',
      'await expect(p).rejects.toBeInstanceOf(Fehlerklasse);',
      "await expect(p).rejects.toMatchObject({ code: '55P03' });",
      'await expect(p).rejects.toBe(rollback);',
      "expect(() => parse('x')).toThrow(/unzulässig/);",
      "expect(error).toMatchObject({ code: 'P2003' });",
      'expect(result.message).toMatch(/gespeichert/);',
      "expect(sent[0], String(sent[0].reason)).toMatchObject({ status: 'fulfilled' });",
      'const sql = `SELECT ${reason}::text`;',
      'uploaded.push(`${key}:${await drain(body)}`);',
    ];
    for (const code of erlaubt)
      expect(abgleichVerstoesse('probe-db.test.ts', code), code).toEqual([]);
  });

  it('findet die DB-Suiten aller Pakete, @taxtronik/db und die Live-Suiten', () => {
    const suiten = dbSuiten(ROOT);
    expect(suiten).toContain('apps/web/src/server/tcms/__tests__/nachweis-verweis-db.test.ts');
    expect(suiten).toContain('apps/worker/src/jobs/__tests__/tcms-nachrichten-db.test.ts');
    expect(suiten).toContain('packages/db/src/__tests__/poa-signing-integrity.test.ts');
    expect(suiten).toContain('packages/evidence/src/__tests__/verify-checkpoint-db.test.ts');
    expect(suiten).toContain('apps/web/src/server/tcms/__tests__/bereich-c-live.test.tsx');
    expect(suiten.length).toBeGreaterThan(150);
  });

  it('DB-Suiten prüfen Ablehnungen nur über die Angaben der Datenbank', () => {
    const offen: string[] = [];
    const genutzt = new Set<Ausnahme>();
    for (const datei of dbSuiten(ROOT)) {
      const code = readFileSync(join(ROOT, datei), 'utf8');
      for (const verstoss of abgleichVerstoesse(datei, code)) {
        const ausnahme = ERLAUBT.find(
          (a) =>
            a.datei === datei && a.regel === verstoss.regel && verstoss.auszug.includes(a.auszug),
        );
        if (ausnahme) genutzt.add(ausnahme);
        else offen.push(`${datei}:${verstoss.zeile} [${verstoss.regel}] ${verstoss.auszug}`);
      }
    }
    expect(
      offen,
      'Ablehnungen in DB-Suiten über dbAbgewiesen/anwendungAbgewiesen (@taxtronik/db/testing/db-fehler) prüfen',
    ).toEqual([]);
    expect(
      ERLAUBT.filter((a) => !genutzt.has(a)).map((a) => `${a.datei} ${a.auszug}`),
      'Ausnahme ohne Treffer entfernen',
    ).toEqual([]);
  });
});
