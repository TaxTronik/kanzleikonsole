// Fachkatalog: ACCESS-TENANT-RLS-001
// =============================================================================
// Prüfhilfen für Datenbankfehler (src/testing/db-fehler.ts, kk-tcms-qual).
//
// Der Regressionsfall zeigt die Falle, die die Helfer schließen: Prisma hängt
// an seine Meldung einen Codeausschnitt der aufrufenden Stelle an. Ein Muster,
// das nur dort steht (hier im Kommentar über dem Aufruf), lässt
// `rejects.toThrow` bestehen, obwohl die Datenbank etwas ganz anderes gemeldet
// hat; `dbAbgewiesen` prüft nur die Angaben der Datenbank und scheitert.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import {
  anwendungAbgewiesen,
  dbAbgewiesen,
  dbFehler,
  erwarteAnwendungsfehler,
  erwarteDbFehler,
  istPrismaFehler,
} from '../testing/db-fehler';

/** Meldung der Prüfung, wenn ein Helfer (zu Recht) scheitert; sonst `null`. */
async function befundVon(pruefung: () => unknown): Promise<string | null> {
  try {
    await pruefung();
  } catch (befund) {
    expect(befund).toBeInstanceOf(Error);
    return (befund as { message: string }).message;
  }
  return null;
}

/** Nachbau eines Prisma-Fehlers mit Treiberadapter (Form wie Prisma 7). */
function prismaFehler(
  code: string,
  cause: Record<string, unknown> | undefined,
  meldung = 'Invalid `prisma.x.update()` invocation in\n/pfad/test.ts:10:5\n\n→ 10 x.update(',
) {
  return Object.assign(new Error(meldung), {
    name: 'PrismaClientKnownRequestError',
    code,
    clientVersion: '7.9.1',
    meta: cause === undefined ? { modelName: 'X' } : { driverAdapterError: { cause } },
  });
}

/** Nachbau eines DatabaseError von node-postgres. */
function pgFehler(code: string, meldung: string, constraint?: string) {
  return Object.assign(new Error(meldung), { code, severity: 'ERROR', constraint });
}

describe('dbFehler', () => {
  it('liest SQLSTATE, Meldung und Bedingung aus dem Treiberadapter, nie aus der Prisma-Meldung', () => {
    const fehler = prismaFehler('P2002', {
      originalCode: '23505',
      originalMessage: 'duplicate key value violates unique constraint "x_key"',
      constraint: { index: 'x_key' },
    });
    expect(dbFehler(fehler)).toEqual({
      quelle: 'prisma',
      prismaCode: 'P2002',
      sqlState: '23505',
      meldung: 'duplicate key value violates unique constraint "x_key"',
      constraint: 'x_key',
    });
  });

  it('meldet für P2025 nur den Prisma-Code (keine Angaben der Datenbank)', () => {
    expect(dbFehler(prismaFehler('P2025', undefined))).toEqual({
      quelle: 'prisma',
      prismaCode: 'P2025',
      sqlState: null,
      meldung: null,
      constraint: null,
    });
  });

  it('liest den DatabaseError von node-postgres', () => {
    expect(dbFehler(pgFehler('23514', 'Regel verletzt', 'x_check'))).toEqual({
      quelle: 'pg',
      prismaCode: null,
      sqlState: '23514',
      meldung: 'Regel verletzt',
      constraint: 'x_check',
    });
  });

  it('erkennt Fehler der Anwendung nicht als Datenbankfehler, auch nicht mit DB-Fehler als cause', () => {
    const anwendung = new Error('Konflikt', { cause: pgFehler('23505', 'doppelt') });
    expect(dbFehler(anwendung)).toBeNull();
    expect(dbFehler('23505')).toBeNull();
    expect(dbFehler(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBeNull();
    expect(istPrismaFehler(anwendung)).toBe(false);
    expect(istPrismaFehler(prismaFehler('P2025', undefined))).toBe(true);
  });
});

describe('erwarteDbFehler/erwarteAnwendungsfehler (ohne Datenbank)', () => {
  const unique = prismaFehler('P2002', {
    originalCode: '23505',
    originalMessage: 'duplicate key value violates unique constraint "x_key"',
    constraint: { index: 'x_key' },
  });

  it('besteht nur, wenn jedes genannte Merkmal der Datenbank passt', async () => {
    erwarteDbFehler(unique, { sqlState: '23505', constraint: 'x_key', prismaCode: 'P2002' });
    erwarteDbFehler(unique, 'unique constraint "x_key"');
    erwarteDbFehler(unique, { sqlState: ['23505', '40001'] });
    expect(await befundVon(() => erwarteDbFehler(unique, { sqlState: '23514' }))).toMatch(
      /SQLSTATE/,
    );
    expect(await befundVon(() => erwarteDbFehler(unique, { constraint: 'y_key' }))).toMatch(
      /Bedingung/,
    );
    // Das Muster steht nur in der Prisma-Meldung (Codeausschnitt), nicht in der Datenbank.
    expect(await befundVon(() => erwarteDbFehler(unique, /x\.update/))).toMatch(
      /Meldung der Datenbank/,
    );
  });

  it('verlangt mindestens ein Merkmal und einen Datenbankfehler', async () => {
    expect(await befundVon(() => erwarteDbFehler(unique, {}))).toMatch(/mindestens ein Merkmal/);
    expect(await befundVon(() => erwarteDbFehler(new Error('x'), 'x'))).toMatch(
      /erwartet: Datenbankfehler/,
    );
  });

  it('weist Datenbank- und Prisma-Fehler sowie Meldungen mit Codeausschnitt als Anwendungsfehler ab', async () => {
    class Verweigert extends Error {}
    erwarteAnwendungsfehler(new Verweigert('Kein Zugriff.'), {
      klasse: Verweigert,
      meldung: 'Kein',
    });
    // Meldung einer Raw-Abfrage ohne Ausschnitt darf ein Anwendungsfehler wiedergeben.
    erwarteAnwendungsfehler(new Error('Prüfung: permission denied for table x'), /permission/);
    expect(await befundVon(() => erwarteAnwendungsfehler(unique, /x/))).toMatch(
      /erwartet: Fehler der Anwendung/,
    );
    expect(await befundVon(() => erwarteAnwendungsfehler(pgFehler('42501', 'x'), /x/))).toMatch(
      /erwartet: Fehler der Anwendung/,
    );
    const eingebettet = new Error(
      'Wiederherstellung abgebrochen: Invalid `tx.x.update()` invocation in\n/pfad:1:1',
    );
    expect(await befundVon(() => erwarteAnwendungsfehler(eingebettet, /abgebrochen/))).toMatch(
      /Prisma-Codeausschnitt/,
    );
    expect(await befundVon(() => erwarteAnwendungsfehler(new Verweigert('x'), {}))).toMatch(
      /meldung oder klasse/,
    );
  });

  it('dbAbgewiesen/anwendungAbgewiesen scheitern, wenn der Aufruf gelingt', async () => {
    expect(await befundVon(() => dbAbgewiesen(Promise.resolve(1), { sqlState: '23505' }))).toMatch(
      /erwartet: Ablehnung durch die Datenbank/,
    );
    expect(await befundVon(() => anwendungAbgewiesen(() => 1, 'x'))).toMatch(
      /erwartet: Ablehnung durch die Anwendung/,
    );
    // Synchron werfende Funktionen zählen als Ablehnung.
    await anwendungAbgewiesen(() => {
      throw new Error('sofort');
    }, 'sofort');
  });
});

const hasDatabase = Boolean(process.env['DATABASE_URL'] && process.env['DATABASE_APP_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('Prüfhilfen-Test braucht DATABASE_URL und DATABASE_APP_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});
const pg = new Client({ connectionString: optionalDatabaseUrl(process.env['DATABASE_URL']) });

class Rueckrollen extends Error {}

function aktualisiereFehlendenTenant() {
  // Muster nur im Codeausschnitt: Vernichtungsclaim eingefroren (23001)
  return owner.tenant.update({ where: { id: randomUUID() }, data: { name: 'nie' } });
}

describeWithDatabase('Prüfhilfen gegen PostgreSQL', () => {
  beforeAll(async () => {
    if (hasDatabase) await pg.connect();
  });

  afterAll(async () => {
    await Promise.all([owner.$disconnect(), hasDatabase ? pg.end() : undefined]);
  });

  it('Regression: ein Muster nur im Codeausschnitt besteht rejects.toThrow, nicht dbAbgewiesen', async () => {
    // Die Falle: Die Datenbank meldet nichts dergleichen (P2025, keine Zeile),
    // trotzdem besteht der alte Abgleich über die zusammengesetzte Meldung.
    await expect(aktualisiereFehlendenTenant()).rejects.toThrow(/Vernichtungsclaim eingefroren/);
    expect(
      await befundVon(() =>
        dbAbgewiesen(aktualisiereFehlendenTenant(), /Vernichtungsclaim eingefroren/),
      ),
    ).toMatch(/Meldung der Datenbank null trifft nicht/);
    expect(
      await befundVon(() => dbAbgewiesen(aktualisiereFehlendenTenant(), { sqlState: '23001' })),
    ).toMatch(/SQLSTATE/);
    // Was die Datenbank tatsächlich geliefert hat:
    await expect(
      dbAbgewiesen(aktualisiereFehlendenTenant(), { prismaCode: 'P2025' }),
    ).resolves.toEqual({
      quelle: 'prisma',
      prismaCode: 'P2025',
      sqlState: null,
      meldung: null,
      constraint: null,
    });
    // Als Fehler der Anwendung gilt ein Prisma-Fehler nie.
    expect(
      await befundVon(() =>
        anwendungAbgewiesen(aktualisiereFehlendenTenant(), /Vernichtungsclaim/),
      ),
    ).toMatch(/erwartet: Fehler der Anwendung/);
  });

  it('liest UNIQUE-Verletzungen eines Modellaufrufs aus dem Treiberadapter', async () => {
    const slug = `db-fehler-${randomUUID()}`;
    try {
      await owner.$transaction(async (tx) => {
        await tx.tenant.create({ data: { slug, name: 'Prüfhilfe' } });
        const info = await dbAbgewiesen(tx.tenant.create({ data: { slug, name: 'doppelt' } }), {
          sqlState: '23505',
          prismaCode: 'P2002',
          meldung: /^duplicate key value violates unique constraint "tenant_slug_key"$/,
        });
        expect(info.quelle).toBe('prisma');
        throw new Rueckrollen();
      });
    } catch (fehler) {
      if (!(fehler instanceof Rueckrollen)) throw fehler;
    }
  });

  it('liest Fehler aus Raw-Abfragen von Prisma und node-postgres', async () => {
    const roh = await dbAbgewiesen(owner.$queryRawUnsafe('SELECT 1/0'), {
      sqlState: '22012',
      meldung: 'division by zero',
    });
    expect(roh.quelle).toBe('prisma');
    const direkt = await dbAbgewiesen(pg.query('SELECT 1/0'), {
      sqlState: '22012',
      meldung: /^division by zero$/,
    });
    expect(direkt).toEqual({
      quelle: 'pg',
      prismaCode: null,
      sqlState: '22012',
      meldung: 'division by zero',
      constraint: null,
    });
  });
});
