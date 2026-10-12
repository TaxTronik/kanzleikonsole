// Fachkatalog: ACCESS-TENANT-RLS-001
// =============================================================================
// Welle 15: Datenbankbezogene Rolleneinstellungen (pg_db_role_setting) gehören
// nicht zum pg_dump. CANONICAL_ROLE_SETTINGS ist ihre einzige Quelle für
// Restore und Restore-Gate. Belegt werden (1) die Übereinstimmung mit allen
// Migrationen, (2) mit einer frisch migrierten Datenbank und (3) gegen eine neu
// angelegte Datenbank wie nach einem Restore: Die Migrationsrolle setzt die
// Werte, die App-Rolle erhält sie in neuen Verbindungen, eine Rolle ohne Recht
// auf ALTER ROLE scheitert vor jeder Änderung.
// =============================================================================
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, requireDatabaseUrl } from '../prisma-adapter';
import {
  alterRoleSettingStatement,
  applyCanonicalRoleSettings,
  CANONICAL_ROLE_SETTINGS,
  ROLE_SETTING_ROLES,
} from '../restore-security';

const MIGRATIONS = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));
const INIT = fileURLToPath(new URL('../../prisma/init/', import.meta.url));

/** Ohne Kommentare: Kommentare zitieren ALTER ROLE, ohne es auszuführen. */
function sqlWithoutComments(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n').replace(/--.*$/gm, '');
}

/** Jedes ALTER ROLE/USER … [IN DATABASE …] SET|RESET und ALTER DATABASE … SET|RESET. */
function roleSettingStatements(sql: string): Array<{ role: string; name: string }> {
  const found: Array<{ role: string; name: string }> = [];
  const role =
    /ALTER\s+(?:ROLE|USER)\s+("?[\w%]+"?)\s+(?:IN\s+DATABASE\s+\S+\s+)?(?:SET|RESET)\s+("?[\w.]+"?|ALL)/gi;
  for (const match of sql.matchAll(role)) {
    found.push({ role: match[1]!.replace(/"/g, ''), name: match[2]!.replace(/"/g, '') });
  }
  const database = /ALTER\s+DATABASE\s+\S+\s+(?:SET|RESET)\s+("?[\w.]+"?|ALL)/gi;
  for (const match of sql.matchAll(database)) {
    found.push({ role: '<database>', name: match[1]!.replace(/"/g, '') });
  }
  return found;
}

describe('Welle 15: kanonische Rolleneinstellungen = Migrationen', () => {
  const migrations = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const statements = migrations.flatMap((migration) =>
    roleSettingStatements(sqlWithoutComments(join(MIGRATIONS, migration, 'migration.sql'))).map(
      (statement) => ({ ...statement, migration }),
    ),
  );

  it('erkennt das bekannte ALTER ROLE … IN DATABASE … SET (Selbsttest des Scanners)', () => {
    expect(
      roleSettingStatements(
        "EXECUTE format('ALTER ROLE taxtronik_app IN DATABASE %I SET lock_timeout = %L', x, '5s');" +
          ' ALTER ROLE "taxtronik_owner" RESET statement_timeout; ALTER DATABASE taxtronik SET search_path TO app;' +
          ' ALTER ROLE taxtronik_owner NOSUPERUSER NOCREATEDB;',
      ),
    ).toEqual([
      { role: 'taxtronik_app', name: 'lock_timeout' },
      { role: 'taxtronik_owner', name: 'statement_timeout' },
      { role: '<database>', name: 'search_path' },
    ]);
  });

  it('führt jede Rolleneinstellung der Migrationen genau einmal kanonisch', () => {
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.map(({ role, name, migration }) => ({ role, name, migration }))).toEqual(
      CANONICAL_ROLE_SETTINGS.map(({ role, name, migration }) => ({ role, name, migration })),
    );
  });

  it('übernimmt Werte wörtlich aus der setzenden Migration', () => {
    for (const setting of CANONICAL_ROLE_SETTINGS) {
      const sql = sqlWithoutComments(join(MIGRATIONS, setting.migration, 'migration.sql'));
      expect(sql).toContain(setting.role);
      expect(sql).toContain(setting.name);
      expect(sql).toContain(`'${setting.value}'`);
      expect(ROLE_SETTING_ROLES).toContain(setting.role);
    }
  });

  it('kennt außerhalb der Migrationen keine weitere Rolleneinstellung (Bootstrap)', () => {
    for (const file of readdirSync(INIT)) {
      expect(roleSettingStatements(sqlWithoutComments(join(INIT, file)))).toEqual([]);
    }
  });

  it('erzeugt statische ALTER-ROLE-Anweisungen nur aus geprüften Bestandteilen', () => {
    expect(alterRoleSettingStatement(CANONICAL_ROLE_SETTINGS[0]!)).toBe(
      'DO $taxtronik_role_setting$ BEGIN EXECUTE pg_catalog.format(' +
        "'ALTER ROLE %I IN DATABASE %I SET %I = %L', 'taxtronik_app', " +
        "pg_catalog.current_database(), 'lock_timeout', '5s'); END $taxtronik_role_setting$",
    );
    expect(() =>
      alterRoleSettingStatement({
        ...CANONICAL_ROLE_SETTINGS[0]!,
        value: "5s'; DROP TABLE tenant; --",
      }),
    ).toThrow('Ungültige kanonische Rolleneinstellung');
  });
});

const url = requireDatabaseUrl(process.env['DATABASE_URL'], 'DATABASE_URL');
const appUrl = requireDatabaseUrl(process.env['DATABASE_APP_URL'], 'DATABASE_APP_URL');
const owner = new PrismaClient({ adapter: createPostgresAdapter(url) });
const writerFor = (target: string) => new PrismaClient({ adapter: createPostgresAdapter(target) });
afterAll(() => owner.$disconnect());

function withDatabase(connection: string, database: string): string {
  const parsed = new URL(connection);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** Owner-Verbindung (ohne CREATEROLE) wie in owner-role-privileges.test.ts. */
function ownerRoleUrl(database: string): string {
  const configured = process.env['DATABASE_OWNER_URL'];
  const parsed = new URL(configured ?? url);
  if (!configured) {
    parsed.username = 'taxtronik_owner';
    parsed.password = 'taxtronik_owner';
  }
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function settingsOf(database: string): Promise<string[]> {
  const rows = await owner.$queryRaw<Array<{ entry: string }>>`
    SELECT COALESCE(r.rolname, '<database>') || ' ' || cfg AS "entry"
      FROM pg_catalog.pg_db_role_setting s
      LEFT JOIN pg_catalog.pg_roles r ON r.oid = s.setrole
      CROSS JOIN LATERAL pg_catalog.unnest(s.setconfig) AS cfg
     WHERE s.setdatabase = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = ${database})
  `;
  return rows.map((row) => row.entry).sort();
}

const CANONICAL = CANONICAL_ROLE_SETTINGS.map((s) => `${s.role} ${s.name}=${s.value}`).sort();

describe('Welle 15: kanonische Rolleneinstellungen gegen echtes PostgreSQL', () => {
  it('entsprechen genau dem Stand einer frisch migrierten Datenbank', async () => {
    const [current] = await owner.$queryRaw<Array<{ db: string }>>`
      SELECT pg_catalog.current_database() AS "db"
    `;
    await expect(settingsOf(current!.db)).resolves.toEqual(CANONICAL);
  });

  it('setzt sie in einer neu angelegten Datenbank wie nach einem Restore', async () => {
    // Nur intern erzeugte ASCII-Kennung erreicht DDL.
    const scratch = `tt_role_settings_${randomBytes(6).toString('hex')}`;
    await owner.$executeRawUnsafe(`CREATE DATABASE ${scratch}`);
    try {
      // Neue Datenbank: pg_dump/pg_restore bringen keine Rolleneinstellung mit.
      await expect(settingsOf(scratch)).resolves.toEqual([]);

      // Owner-Rolle ohne CREATEROLE: scheitert vor jeder Änderung.
      await expect(applyCanonicalRoleSettings(ownerRoleUrl(scratch), writerFor)).rejects.toThrow(
        /Abbruch vor pg_restore.*Migrationsrolle bzw\. als Superuser/s,
      );
      await expect(settingsOf(scratch)).resolves.toEqual([]);

      // Migrationsrolle: setzt genau den kanonischen Satz, zweiter Lauf ist No-op.
      await expect(
        applyCanonicalRoleSettings(withDatabase(url, scratch), writerFor),
      ).resolves.toEqual(CANONICAL);
      await expect(settingsOf(scratch)).resolves.toEqual(CANONICAL);
      await expect(
        applyCanonicalRoleSettings(withDatabase(url, scratch), writerFor),
      ).resolves.toEqual([]);

      // Wirkung: neue Verbindung der App-Rolle zur neuen Datenbank.
      const app = new Client({ connectionString: withDatabase(appUrl, scratch) });
      await app.connect();
      try {
        const { rows } = await app.query<{ lock: string }>(
          "SELECT current_setting('lock_timeout') AS lock",
        );
        expect(rows[0]?.lock).toBe('5s');
      } finally {
        await app.end();
      }

      // Zusätzliche Einstellung einer Dienstrolle: kein stilles Entfernen.
      await owner.$executeRawUnsafe(
        `ALTER ROLE taxtronik_owner IN DATABASE ${scratch} SET lock_timeout = '5s'`,
      );
      await expect(
        applyCanonicalRoleSettings(withDatabase(url, scratch), writerFor),
      ).rejects.toThrow(
        /abweichend oder zusätzlich: taxtronik_owner lock_timeout=5s.*RESET <parameter>/s,
      );
    } finally {
      await owner.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
    }
  }, 30_000);
});
