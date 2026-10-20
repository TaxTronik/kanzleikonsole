// =============================================================================
// Abgleich gegen Datenbankfehler in DB-Suiten (TCMS Stufe 3, kk-tcms-qual).
//
// Prisma hängt an die Meldung eines Fehlers einen Codeausschnitt der
// aufrufenden Stelle: Quellpfad, Modell und Methode, die Zeilen vor dem Aufruf
// und den Aufruf selbst. Ein `rejects.toThrow(/Muster/)` – ebenso
// `toThrowError`, ein Abgleich auf `String(e)` oder `e.message` – besteht
// deshalb auch dann, wenn das Muster nur in diesem Ausschnitt steht (etwa im
// Muster der Zeile davor oder im Dateipfad), die Datenbank also aus einem
// anderen Grund abgewiesen hat als der geprüften Regel (Nebenbefund TCMS s7:
// eine Trigger-Mutation in nachweis-verweis-db.test.ts blieb grün).
//
// Diese Helfer prüfen nur, was die Datenbank selbst liefert: SQLSTATE und
// Meldung (Prisma: `meta.driverAdapterError.cause`, node-postgres: `code` und
// `message` des DatabaseError), den Namen der verletzten Bedingung und den
// Prisma-Code (z. B. P2025 für eine von RLS ausgeblendete Zeile) – nie die
// zusammengesetzte Prisma-Meldung. Fehler der Anwendung prüft
// `anwendungAbgewiesen`; er weist Datenbank- und Prisma-Fehler zurück, damit ein
// Test nicht unbemerkt an einem Datenbankfehler vorbei grün wird.
//
// Der Guard apps/web/src/__tests__/db-fehlerabgleich.test.ts verbietet in
// DB-Suiten jeden anderen Abgleich gegen abgewiesene Aufrufe.
// =============================================================================

import { expect } from 'vitest';

/** Angaben der Datenbank zu einem Fehler, ohne die Meldung von Prisma. */
export interface DbFehler {
  /** Herkunft: Prisma-Client (Treiberadapter) oder node-postgres. */
  quelle: 'prisma' | 'pg';
  /** Prisma-Code (z. B. P2002, P2025, P2039), bei node-postgres `null`. */
  prismaCode: string | null;
  /** SQLSTATE der Datenbank (z. B. 23514), `null` ohne Datenbankfehler (P2025). */
  sqlState: string | null;
  /** Meldung der Datenbank (RAISE-Text, Meldung der Bedingung), sonst `null`. */
  meldung: string | null;
  /** Name der verletzten Bedingung, soweit die Datenbank ihn nennt. */
  constraint: string | null;
}

/** Muster wie bei `toThrow`: RegExp oder Teilzeichenkette. */
export type Muster = RegExp | string;

/** Erwartete Ablehnung durch die Datenbank; mindestens ein Merkmal. */
export interface DbErwartung {
  /** Meldung der Datenbank (nie die Prisma-Meldung mit Codeausschnitt). */
  meldung?: Muster;
  /** SQLSTATE, z. B. '42501' (RLS, Rechte), '23514' (CHECK, Trigger). */
  sqlState?: string | readonly string[];
  /** Prisma-Code, z. B. 'P2025' (Zeile unter RLS nicht sichtbar). */
  prismaCode?: string;
  /** Name der verletzten Bedingung (CHECK, UNIQUE, FK). */
  constraint?: string;
}

/** Erwarteter Fehler der Anwendung (kein Datenbank- oder Prisma-Fehler). */
export interface AnwendungsErwartung {
  /** Meldung des Fehlers. */
  meldung?: Muster;
  /** Klasse des Fehlers. */
  klasse?: abstract new (...args: never[]) => Error;
}

/** Ein Promise oder eine Funktion, deren Aufruf (synchron oder asynchron) scheitern soll. */
export type Aufruf = PromiseLike<unknown> | (() => unknown);

const SQLSTATE = /^[0-9A-Z]{5}$/;
const PRISMA_CODE = /^P\d{4}$/;
/**
 * Codeausschnitt einer Prisma-Meldung („Invalid `tx.x.update()` invocation in
 * <Pfad>:<Zeile>“ samt markierter Aufrufzeile). Raw-Abfragen tragen keinen
 * Ausschnitt; ihre Meldung darf ein Fehler der Anwendung wiedergeben.
 */
const PRISMA_RAHMEN = /` invocation in\r?\n|^\s*→\s*\d+\s/m;

function feld(quelle: unknown, name: string): unknown {
  return quelle !== null && typeof quelle === 'object'
    ? (quelle as Record<string, unknown>)[name]
    : undefined;
}

function text(wert: unknown): string | null {
  return typeof wert === 'string' ? wert : null;
}

function constraintAus(cause: unknown): string | null {
  const constraint = feld(cause, 'constraint');
  if (typeof constraint === 'string') return constraint;
  const index = feld(constraint, 'index');
  if (typeof index === 'string') return index;
  const felder = feld(constraint, 'fields');
  return Array.isArray(felder) ? felder.join(',') : null;
}

/** Ist `fehler` ein Fehler des Prisma-Clients (mit oder ohne Datenbankfehler)? */
export function istPrismaFehler(fehler: unknown): boolean {
  const name = text(feld(fehler, 'name'));
  return (
    typeof feld(fehler, 'clientVersion') === 'string' ||
    (name !== null && name.startsWith('PrismaClient'))
  );
}

/**
 * Datenbankangaben eines Fehlers: Prisma-Fehler mit Code (Treiberadapter
 * `meta.driverAdapterError.cause`; ohne Adapter `meta.code`/`meta.message`)
 * oder DatabaseError von node-postgres. `null` für alles andere, auch für
 * Fehler der Anwendung, die einen Datenbankfehler als `cause` tragen.
 */
export function dbFehler(fehler: unknown): DbFehler | null {
  const code = text(feld(fehler, 'code'));
  if (code !== null && PRISMA_CODE.test(code) && istPrismaFehler(fehler)) {
    const meta = feld(fehler, 'meta');
    const cause = feld(feld(meta, 'driverAdapterError'), 'cause');
    const sqlState = text(feld(cause, 'originalCode')) ?? text(feld(meta, 'code'));
    return {
      quelle: 'prisma',
      prismaCode: code,
      sqlState: sqlState !== null && SQLSTATE.test(sqlState) ? sqlState : null,
      meldung: text(feld(cause, 'originalMessage')) ?? text(feld(meta, 'message')),
      constraint: constraintAus(cause),
    };
  }
  if (code !== null && SQLSTATE.test(code) && typeof feld(fehler, 'severity') === 'string') {
    return {
      quelle: 'pg',
      prismaCode: null,
      sqlState: code,
      meldung: text(feld(fehler, 'message')),
      constraint: text(feld(fehler, 'constraint')),
    };
  }
  return null;
}

function trifft(muster: Muster, wert: string): boolean {
  return typeof muster === 'string' ? wert.includes(muster) : muster.test(wert);
}

async function ablehnung(aufruf: Aufruf): Promise<{ abgewiesen: boolean; fehler: unknown }> {
  try {
    await (typeof aufruf === 'function' ? aufruf() : aufruf);
  } catch (fehler) {
    return { abgewiesen: true, fehler };
  }
  return { abgewiesen: false, fehler: undefined };
}

function beschreibung(fehler: unknown): string {
  const info = dbFehler(fehler);
  if (info) return JSON.stringify(info);
  // Nur Klasse und erste Zeile: keine Prisma-Ausschnitte in Testausgaben.
  const name = text(feld(fehler, 'name')) ?? typeof fehler;
  const meldung = text(feld(fehler, 'message')) ?? String(fehler);
  return `${name}: ${meldung.split('\n').find((zeile) => zeile.trim() !== '') ?? ''}`;
}

function dbSoll(erwartung: Muster | DbErwartung): DbErwartung {
  return typeof erwartung === 'string' || erwartung instanceof RegExp
    ? { meldung: erwartung }
    : erwartung;
}

function anwendungSoll(erwartung: Muster | AnwendungsErwartung): AnwendungsErwartung {
  return typeof erwartung === 'string' || erwartung instanceof RegExp
    ? { meldung: erwartung }
    : erwartung;
}

function praefix(hinweis: string | undefined): string {
  return hinweis === undefined ? '' : `${hinweis}: `;
}

function pruefeDbErwartung(soll: DbErwartung, vor: string): void {
  const merkmale = [soll.meldung, soll.sqlState, soll.prismaCode, soll.constraint];
  expect(
    merkmale.some((merkmal) => merkmal !== undefined),
    `${vor}braucht mindestens ein Merkmal (meldung, sqlState, prismaCode, constraint)`,
  ).toBe(true);
}

function pruefeAnwendungsErwartung(soll: AnwendungsErwartung, vor: string): void {
  expect(
    soll.meldung !== undefined || soll.klasse !== undefined,
    `${vor}braucht meldung oder klasse`,
  ).toBe(true);
}

/**
 * Prüft einen bereits gefangenen Fehler (z. B. `reason` aus
 * `Promise.allSettled`) wie `dbAbgewiesen`.
 */
export function erwarteDbFehler(
  fehler: unknown,
  erwartung: Muster | DbErwartung,
  hinweis?: string,
): DbFehler {
  const vor = praefix(hinweis);
  const soll = dbSoll(erwartung);
  pruefeDbErwartung(soll, vor);
  const info = dbFehler(fehler);
  expect(info, `${vor}erwartet: Datenbankfehler, erhalten ${beschreibung(fehler)}`).not.toBeNull();
  const ist = info!;
  if (soll.meldung !== undefined) {
    expect(
      ist.meldung !== null && trifft(soll.meldung, ist.meldung),
      `${vor}Meldung der Datenbank ${JSON.stringify(ist.meldung)} trifft nicht ${String(soll.meldung)}`,
    ).toBe(true);
  }
  if (soll.sqlState !== undefined) {
    const erlaubt: readonly string[] =
      typeof soll.sqlState === 'string' ? [soll.sqlState] : soll.sqlState;
    expect(erlaubt, `${vor}SQLSTATE (${beschreibung(fehler)})`).toContain(ist.sqlState);
  }
  if (soll.prismaCode !== undefined) {
    expect(ist.prismaCode, `${vor}Prisma-Code (${beschreibung(fehler)})`).toBe(soll.prismaCode);
  }
  if (soll.constraint !== undefined) {
    expect(ist.constraint, `${vor}Bedingung (${beschreibung(fehler)})`).toBe(soll.constraint);
  }
  return ist;
}

/**
 * Prüft einen bereits gefangenen Fehler (z. B. `reason` aus
 * `Promise.allSettled`) wie `anwendungAbgewiesen`.
 */
export function erwarteAnwendungsfehler(
  fehler: unknown,
  erwartung: Muster | AnwendungsErwartung,
  hinweis?: string,
): Error {
  const vor = praefix(hinweis);
  const soll = anwendungSoll(erwartung);
  pruefeAnwendungsErwartung(soll, vor);
  expect(
    dbFehler(fehler) === null && !istPrismaFehler(fehler),
    `${vor}erwartet: Fehler der Anwendung, erhalten ${beschreibung(fehler)}`,
  ).toBe(true);
  expect(fehler, `${vor}erwartet: Error, erhalten ${beschreibung(fehler)}`).toBeInstanceOf(Error);
  const ist = fehler as Error;
  expect(
    PRISMA_RAHMEN.test(ist.message),
    `${vor}Meldung enthält einen Prisma-Codeausschnitt: ${beschreibung(fehler)}`,
  ).toBe(false);
  if (soll.klasse !== undefined) expect(ist, `${vor}Fehlerklasse`).toBeInstanceOf(soll.klasse);
  if (soll.meldung !== undefined) {
    expect(
      trifft(soll.meldung, ist.message),
      `${vor}Meldung ${JSON.stringify(ist.message)} trifft nicht ${String(soll.meldung)}`,
    ).toBe(true);
  }
  return ist;
}

/**
 * Erwartet, dass die Datenbank `aufruf` abweist, und prüft nur ihre Angaben
 * (SQLSTATE, Meldung, Bedingung, Prisma-Code). Ein Muster allein prüft die
 * Meldung der Datenbank. Liefert die Angaben für weitere Prüfungen.
 */
export async function dbAbgewiesen(
  aufruf: Aufruf,
  erwartung: Muster | DbErwartung,
  hinweis?: string,
): Promise<DbFehler> {
  const vor = praefix(hinweis);
  pruefeDbErwartung(dbSoll(erwartung), vor);
  const { abgewiesen, fehler } = await ablehnung(aufruf);
  expect(abgewiesen, `${vor}erwartet: Ablehnung durch die Datenbank`).toBe(true);
  return erwarteDbFehler(fehler, erwartung, hinweis);
}

/**
 * Erwartet einen Fehler der Anwendung (eigene Prüfung vor der Datenbank,
 * Fehlerklasse eines Dienstes). Datenbank- und Prisma-Fehler sowie Meldungen
 * mit einem Prisma-Codeausschnitt gelten nicht; die Meldung einer Raw-Abfrage
 * (ohne Ausschnitt) darf ein Fehler der Anwendung wiedergeben.
 */
export async function anwendungAbgewiesen(
  aufruf: Aufruf,
  erwartung: Muster | AnwendungsErwartung,
  hinweis?: string,
): Promise<Error> {
  const vor = praefix(hinweis);
  pruefeAnwendungsErwartung(anwendungSoll(erwartung), vor);
  const { abgewiesen, fehler } = await ablehnung(aufruf);
  expect(abgewiesen, `${vor}erwartet: Ablehnung durch die Anwendung`).toBe(true);
  return erwarteAnwendungsfehler(fehler, erwartung, hinweis);
}
