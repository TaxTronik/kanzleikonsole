// Fachkatalog: ACCESS-TENANT-RLS-001
// Fachkatalog: AUDIT-HASH-CHAIN-001
// Fachkatalog: TAX-DEADLINE-AUTOREQUEST-001
// Fachkatalog: DSGVO-OPERATIONAL-RETENTION-001
// =============================================================================
// S-01: Die Owner-Verbindung der Container (taxtronik_owner) und die
// Restore-Drill-Rolle (taxtronik_drill) sind keine Superuser.
//
// Belegt gegen echtes PostgreSQL: (1) Rollenattribute und Mitgliedschaften,
// (2) genau die Owner-Rechte aus 20261006160000_owner_role_least_privilege
// (DML, Sequenzen, EXECUTE-Parität mit taxtronik_app, SELECT auf allem für
// pg_dump, Default-Privilegien), (3) als echte Anmeldung verbotene Operationen
// (Superuser-GUCs, COPY ... PROGRAM, Rollen-/Datenbank-/Schemaanlage, DDL,
// Trigger abschalten, SET ROLE auf den Superuser), (4) unveränderte RLS-
// Semantik (Owner umgeht RLS, App-Rolle nicht) und (5) den DSGVO-Purge der
// Auto-Request-Verknüpfung nur über app.purge_tax_deadline_request_links.
//
// Verbindungen: DATABASE_URL (Fixtures, Tabellen-Owner), DATABASE_APP_URL,
// DATABASE_OWNER_URL / DATABASE_DRILL_URL oder abgeleitet aus DATABASE_URL mit
// den festen Testpasswörtern aus prisma/init/01_bootstrap.sql.
// =============================================================================
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import type { TxClient } from '../tenant-context';
import { createVerifiedLegalEntityGwgFixture } from './gwg-test-fixture';

const OWNER_ROLE = 'taxtronik_owner';
const DRILL_ROLE = 'taxtronik_drill';
const PURGE_FUNCTION = 'app.purge_tax_deadline_request_links(uuid,uuid[],uuid[])';

const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20261006160000_owner_role_least_privilege/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const migrationSql = migration.replace(/--.*$/gm, '');
const bootstrap = readFileSync(
  new URL('../../prisma/init/01_bootstrap.sql', import.meta.url),
  'utf8',
);

describe('S-01: Migration und Bootstrap der Owner-Rolle', () => {
  it('legt die Rolle ohne Login und ohne Superuser-Attribute an', () => {
    expect(migrationSql).toMatch(
      /CREATE ROLE taxtronik_owner\s+NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;/,
    );
    // Bestehende Rollen: Attribute fail-closed nachziehen, Login/Passwort nie anfassen.
    expect(migrationSql).toMatch(
      /ALTER ROLE taxtronik_owner\s+NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;/,
    );
    expect(migrationSql).not.toMatch(/\bPASSWORD\b/);
    expect(migrationSql).not.toMatch(/\bTRUNCATE\b|\bREFERENCES\b|\bTRIGGER\b|\bMAINTAIN\b/);
  });

  it('kapselt den Purge als SECURITY DEFINER mit festem search_path', () => {
    expect(migrationSql).toMatch(
      /CREATE FUNCTION app\.purge_tax_deadline_request_links\([\s\S]*?SECURITY DEFINER\s+SET search_path = pg_catalog, public, pg_temp/,
    );
    expect(migrationSql).toContain(
      'REVOKE ALL ON FUNCTION app.purge_tax_deadline_request_links(UUID, UUID[], UUID[]) FROM PUBLIC;',
    );
  });

  it('richtet Test- und CI-Datenbanken mit beiden Login-Rollen ein', () => {
    expect(bootstrap).toMatch(
      /CREATE ROLE taxtronik_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION\s+BYPASSRLS PASSWORD 'taxtronik_owner'/,
    );
    expect(bootstrap).toMatch(
      /CREATE ROLE taxtronik_drill LOGIN NOSUPERUSER CREATEDB NOCREATEROLE NOREPLICATION\s+BYPASSRLS PASSWORD 'taxtronik_drill'/,
    );
  });
});

const hasDatabase = Boolean(process.env['DATABASE_URL'] && process.env['DATABASE_APP_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('Owner-Rollen-Test braucht DATABASE_URL und DATABASE_APP_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

/** Login-URL einer Rolle: ausdrücklich gesetzt oder aus DATABASE_URL abgeleitet. */
function roleUrl(role: string, explicit: string | undefined): string {
  if (explicit) return explicit;
  const url = new URL(optionalDatabaseUrl(process.env['DATABASE_URL']));
  url.username = role;
  url.password = role;
  return url.toString();
}

const admin = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});
const app = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_APP_URL'])),
});
const owner = new PrismaClient({
  adapter: createPostgresAdapter(roleUrl(OWNER_ROLE, process.env['DATABASE_OWNER_URL'])),
});
const drill = new PrismaClient({
  adapter: createPostgresAdapter(roleUrl(DRILL_ROLE, process.env['DATABASE_DRILL_URL'])),
});

const ROLLBACK = new Error('rollback');
type Tx = TxClient;

/** Szenario als echte Owner-Anmeldung; alle Änderungen werden zurückgerollt. */
async function asOwnerInRollback(work: (tx: Tx) => Promise<void>): Promise<void> {
  await expect(
    owner.$transaction(async (tx) => {
      await work(tx);
      throw ROLLBACK;
    }),
  ).rejects.toBe(ROLLBACK);
}

let tenantId: string;
let deadlineId: string;
let requestId: string;

describeWithDatabase('S-01: Rollenmodell gegen PostgreSQL', () => {
  beforeAll(async () => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    tenantId = (
      await admin.tenant.create({ data: { slug: `owner-role-${stamp}`, name: 'Owner-Rolle S-01' } })
    ).id;
    const staffId = (
      await admin.staffUser.create({
        data: {
          tenantId,
          email: `owner-role-${stamp}@test.local`,
          fullName: 'Owner-Rolle',
          passwordHash: 'x',
        },
      })
    ).id;
    const clientId = (
      await admin.client.create({
        data: { tenantId, kind: 'JURPERS', name: 'Owner-Rolle Mandant', allowActive: false },
      })
    ).id;
    await createVerifiedLegalEntityGwgFixture(admin, {
      tenantId,
      clientId,
      verifiedBy: staffId,
      validUntil: new Date('2099-12-31T00:00:00.000Z'),
      registerNumber: `HRB OWNER ROLE ${stamp}`,
    });
    await admin.client.update({ where: { id: clientId }, data: { allowActive: true } });
    deadlineId = (
      await admin.taxDeadline.create({
        data: {
          tenantId,
          clientId,
          kind: 'USTA_MONATLICH',
          period: `owner-role-${stamp}`,
          dueDate: new Date('2099-12-31T00:00:00.000Z'),
        },
      })
    ).id;
    requestId = (
      await admin.request.create({
        data: {
          tenantId,
          clientId,
          title: 'Automatische Steuer-Anforderung',
          description: 'S-01-Purge',
          createdByStaff: staffId,
        },
      })
    ).id;
    await admin.$transaction(async (tx) => {
      await tx.request.update({ where: { id: requestId }, data: { taxDeadlineId: deadlineId } });
      await tx.taxDeadline.update({
        where: { id: deadlineId },
        data: {
          requestId,
          autoRequestNotificationStatus: 'FAILED',
          autoRequestNotificationAttemptCount: 1,
          autoRequestNotificationLastAttemptAt: new Date('2026-08-20T09:15:00.000Z'),
          autoRequestNotificationNextAttemptAt: new Date('2026-08-20T09:19:00.000Z'),
          autoRequestNotificationLastError: 'Testaufbau: technischer Fehlschlag.',
        },
      });
    });
  });

  afterAll(async () => {
    if (tenantId) await admin.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([admin, app, owner, drill].map((client) => client.$disconnect()));
  });

  it('Rollenattribute: BYPASSRLS ohne Superuser, keine Mitgliedschaften, kein Besitz', async () => {
    const roles = await admin.$queryRaw<
      Array<{
        rolname: string;
        login: boolean;
        superuser: boolean;
        createdb: boolean;
        createrole: boolean;
        replication: boolean;
        bypassrls: boolean;
        memberships: number;
        owned: number;
      }>
    >`
      SELECT r.rolname,
             r.rolcanlogin AS "login",
             r.rolsuper AS "superuser",
             r.rolcreatedb AS "createdb",
             r.rolcreaterole AS "createrole",
             r.rolreplication AS "replication",
             r.rolbypassrls AS "bypassrls",
             (SELECT count(*)::int FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid)
               AS "memberships",
             ((SELECT count(*) FROM pg_catalog.pg_class c WHERE c.relowner = r.oid)
              + (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.proowner = r.oid)
              + (SELECT count(*) FROM pg_catalog.pg_namespace n WHERE n.nspowner = r.oid)
              + (SELECT count(*) FROM pg_catalog.pg_type t WHERE t.typowner = r.oid))::int
               AS "owned"
        FROM pg_catalog.pg_roles r
       WHERE r.rolname IN (${OWNER_ROLE}, ${DRILL_ROLE})
       ORDER BY r.rolname
    `;
    expect(roles).toEqual([
      {
        rolname: DRILL_ROLE,
        login: true,
        superuser: false,
        createdb: true,
        createrole: false,
        replication: false,
        bypassrls: true,
        memberships: 0,
        owned: 0,
      },
      {
        rolname: OWNER_ROLE,
        login: true,
        superuser: false,
        createdb: false,
        createrole: false,
        replication: false,
        bypassrls: true,
        memberships: 0,
        owned: 0,
      },
    ]);
    const [database] = await admin.$queryRaw<Array<{ dbOwner: string; ownerCreate: boolean }>>`
      SELECT pg_catalog.pg_get_userbyid(d.datdba) AS "dbOwner",
             pg_catalog.has_database_privilege(${OWNER_ROLE}, d.oid, 'CREATE') AS "ownerCreate"
        FROM pg_catalog.pg_database d
       WHERE d.datname = current_database()
    `;
    expect(database?.dbOwner).not.toBe(OWNER_ROLE);
    expect(database?.dbOwner).not.toBe(DRILL_ROLE);
    expect(database?.ownerCreate).toBe(false);
  });

  it('Owner: DML überall, Hash-Chain zweischichtig, kein TRUNCATE/REFERENCES/TRIGGER', async () => {
    const rows = await admin.$queryRaw<
      Array<{
        table: string;
        s: boolean;
        i: boolean;
        u: boolean;
        d: boolean;
        extra: boolean;
        drillAny: boolean;
      }>
    >`
      SELECT n.nspname || '.' || c.relname AS "table",
             pg_catalog.has_table_privilege(${OWNER_ROLE}, c.oid, 'SELECT') AS "s",
             pg_catalog.has_table_privilege(${OWNER_ROLE}, c.oid, 'INSERT') AS "i",
             pg_catalog.has_table_privilege(${OWNER_ROLE}, c.oid, 'UPDATE') AS "u",
             pg_catalog.has_table_privilege(${OWNER_ROLE}, c.oid, 'DELETE') AS "d",
             (pg_catalog.has_table_privilege(${OWNER_ROLE}, c.oid, 'TRUNCATE')
               OR pg_catalog.has_table_privilege(${OWNER_ROLE}, c.oid, 'REFERENCES')
               OR pg_catalog.has_table_privilege(${OWNER_ROLE}, c.oid, 'TRIGGER')
               OR CASE WHEN current_setting('server_version_num')::int >= 170000
                       THEN pg_catalog.has_table_privilege(${OWNER_ROLE}, c.oid, 'MAINTAIN')
                       ELSE false END) AS "extra",
             (pg_catalog.has_table_privilege(${DRILL_ROLE}, c.oid, 'SELECT')
               OR pg_catalog.has_table_privilege(${DRILL_ROLE}, c.oid, 'INSERT')
               OR pg_catalog.has_table_privilege(${DRILL_ROLE}, c.oid, 'UPDATE')
               OR pg_catalog.has_table_privilege(${DRILL_ROLE}, c.oid, 'DELETE')) AS "drillAny"
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'p')
         AND n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND n.nspname NOT LIKE 'pg_toast%'
       ORDER BY 1
    `;
    expect(rows.length).toBeGreaterThan(100);
    const exceptions: Record<string, { i: boolean; u: boolean; d: boolean }> = {
      'public._prisma_migrations': { i: false, u: false, d: false },
      'public.audit_log': { i: true, u: false, d: false },
      'public.audit_seal': { i: true, u: false, d: false },
      'public.audit_anchor': { i: true, u: false, d: false },
      'public.audit_archive': { i: true, u: true, d: false },
    };
    const mismatches = rows.filter((row) => {
      const expected = exceptions[row.table] ?? { i: true, u: true, d: true };
      return (
        !row.s ||
        row.i !== expected.i ||
        row.u !== expected.u ||
        row.d !== expected.d ||
        row.extra ||
        row.drillAny
      );
    });
    // SELECT auf jeder Tabelle (pg_dump des Worker-Backups), keine Tabelle
    // für die Drill-Rolle in der Produktiv-DB.
    expect(mismatches).toEqual([]);
    expect(rows.map((row) => row.table)).toEqual(expect.arrayContaining(Object.keys(exceptions)));

    const [sequences] = await admin.$queryRaw<
      Array<{ total: number; usable: number; settable: number }>
    >`
      SELECT count(*)::int AS "total",
             count(*) FILTER (
               WHERE pg_catalog.has_sequence_privilege(${OWNER_ROLE}, c.oid, 'USAGE')
                 AND pg_catalog.has_sequence_privilege(${OWNER_ROLE}, c.oid, 'SELECT')
             )::int AS "usable",
             count(*) FILTER (
               WHERE pg_catalog.has_sequence_privilege(${OWNER_ROLE}, c.oid, 'UPDATE')
             )::int AS "settable"
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind = 'S' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    `;
    expect(sequences?.total).toBeGreaterThan(0);
    expect(sequences?.usable).toBe(sequences?.total);
    expect(sequences?.settable).toBe(0);

    const [schemas] = await admin.$queryRaw<Array<{ usage: boolean; create: boolean }>>`
      SELECT pg_catalog.has_schema_privilege(${OWNER_ROLE}, 'public', 'USAGE')
               AND pg_catalog.has_schema_privilege(${OWNER_ROLE}, 'app', 'USAGE') AS "usage",
             pg_catalog.has_schema_privilege(${OWNER_ROLE}, 'public', 'CREATE')
               OR pg_catalog.has_schema_privilege(${OWNER_ROLE}, 'app', 'CREATE') AS "create"
    `;
    expect(schemas).toEqual({ usage: true, create: false });
  });

  it('Owner: EXECUTE-Parität mit taxtronik_app, einzige Zusatzfunktion ist der Purge', async () => {
    const missing = await admin.$queryRaw<Array<{ routine: string }>>`
      SELECT p.oid::regprocedure::text AS "routine"
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname IN ('app', 'public')
         AND pg_catalog.has_function_privilege('taxtronik_app', p.oid, 'EXECUTE')
         AND NOT pg_catalog.has_function_privilege(${OWNER_ROLE}, p.oid, 'EXECUTE')
       ORDER BY 1
    `;
    expect(missing).toEqual([]);
    const ownerOnly = await admin.$queryRaw<Array<{ routine: string; drill: boolean }>>`
      SELECT p.oid::regprocedure::text AS "routine",
             pg_catalog.has_function_privilege(${DRILL_ROLE}, p.oid, 'EXECUTE') AS "drill"
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname IN ('app', 'public')
         AND pg_catalog.has_function_privilege(${OWNER_ROLE}, p.oid, 'EXECUTE')
         AND NOT pg_catalog.has_function_privilege('taxtronik_app', p.oid, 'EXECUTE')
       ORDER BY 1
    `;
    expect(ownerOnly).toEqual([{ routine: PURGE_FUNCTION, drill: false }]);
  });

  it('Owner: Default-Privilegien für künftige Tabellen und Sequenzen der Migrationsrolle', async () => {
    const defaults = await admin.$queryRaw<Array<{ objtype: string; privileges: string }>>`
      SELECT d.defaclobjtype::text AS "objtype",
             string_agg(acl.privilege_type, ',' ORDER BY acl.privilege_type) AS "privileges"
        FROM pg_catalog.pg_default_acl d
        CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) acl
       WHERE d.defaclnamespace = 'public'::regnamespace
         AND d.defaclrole = (SELECT relowner FROM pg_catalog.pg_class WHERE oid = 'public.tenant'::regclass)
         AND acl.grantee = ${OWNER_ROLE}::regrole
       GROUP BY d.defaclobjtype
       ORDER BY 1
    `;
    expect(defaults).toEqual([
      { objtype: 'S', privileges: 'SELECT,USAGE' },
      { objtype: 'r', privileges: 'DELETE,INSERT,SELECT,UPDATE' },
    ]);
  });

  it.each([
    [
      'Superuser-GUC',
      'SET session_replication_role = replica',
      /permission denied to set parameter "session_replication_role"/,
    ],
    [
      'COPY ... TO PROGRAM',
      "COPY (SELECT 1) TO PROGRAM 'true'",
      /COPY to or from an external program/,
    ],
    [
      'Serverdatei lesen',
      "SELECT pg_read_file('postgresql.conf')",
      /permission denied for function pg_read_file/,
    ],
    ['Rolle anlegen', 'CREATE ROLE s01_probe_role', /permission denied to create role/],
    [
      'eigene Rechte erweitern',
      'ALTER ROLE taxtronik_owner SUPERUSER',
      /permission denied to alter role/,
    ],
    ['Rolle wechseln', 'SET ROLE taxtronik', /permission denied to set role "taxtronik"/],
    ['Schema anlegen', 'CREATE SCHEMA s01_probe', /permission denied for database/],
    [
      'Tabelle anlegen',
      'CREATE TABLE public.s01_probe (id integer)',
      /permission denied for schema public/,
    ],
    ['Tabelle löschen', 'DROP TABLE public.tenant', /must be owner of table tenant/],
    [
      'Audit-Trigger abschalten',
      'ALTER TABLE public.audit_log DISABLE TRIGGER audit_log_no_modify',
      /must be owner of table audit_log/,
    ],
    ['Audit leeren', 'TRUNCATE public.audit_log', /permission denied for table audit_log/],
    [
      'Audit ändern',
      'UPDATE public.audit_log SET action = action WHERE false',
      /permission denied for table audit_log/,
    ],
    [
      'Archivsegment löschen',
      'DELETE FROM public.audit_archive WHERE false',
      /permission denied for table audit_archive/,
    ],
    [
      'Migrations-Ledger ändern',
      'DELETE FROM public._prisma_migrations WHERE false',
      /permission denied for table _prisma_migrations/,
    ],
  ])('Owner-Anmeldung verweigert: %s', async (_label, statement, error) => {
    // Fehlte eine Sperre, bliebe trotzdem nichts zurück: SET, DDL und Rollen
    // sind transaktional, die Transaktion wird in jedem Fall zurückgerollt.
    await expect(
      owner.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(statement);
        throw ROLLBACK;
      }),
    ).rejects.toThrow(error);
  });

  it('Owner-Anmeldung verweigert CREATE DATABASE (kein CREATEDB)', async () => {
    // CREATE DATABASE läuft außerhalb jeder Transaktion; gelänge es doch,
    // entfernt der finally-Block die Probe-Datenbank sofort wieder.
    const probe = `s01_probe_${randomUUID().replaceAll('-', '')}`;
    try {
      await expect(owner.$executeRawUnsafe(`CREATE DATABASE ${probe}`)).rejects.toThrow(
        /permission denied to create database/,
      );
    } finally {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${probe}`);
    }
  });

  it('RLS-Semantik unverändert: Owner liest ohne Kontext, die App-Rolle nicht', async () => {
    await asOwnerInRollback(async (tx) => {
      const [visible] = await tx.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS "n" FROM public.tenant WHERE id = ${tenantId}::uuid
      `;
      expect(visible?.n).toBe(1);
      const updated = await tx.$executeRaw`
        UPDATE public.tenant SET name = name WHERE id = ${tenantId}::uuid
      `;
      expect(updated).toBe(1);
      // Audit-Insert über die Sequenz wie evidence.record (wird zurückgerollt).
      const inserted = await tx.$executeRaw`
        INSERT INTO public.audit_log (
          tenant_id, occurred_at, actor_type, action, resource_type, prev_hash, this_hash
        ) VALUES (
          ${tenantId}::uuid, clock_timestamp(), 'SYSTEM', 's01.probe', 'test',
          ${Buffer.alloc(32, 1)}, ${Buffer.alloc(32, 2)}
        )
      `;
      expect(inserted).toBe(1);
    });
    const [hidden] = await app.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS "n" FROM public.tenant WHERE id = ${tenantId}::uuid
    `;
    expect(hidden?.n).toBe(0);
  });

  it('TAX-DEADLINE-AUTOREQUEST-001: freies GUC autorisiert den Owner nicht zum Purge', async () => {
    await asOwnerInRollback(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.tax_deadline_notification_purge', 'on', true)`;
      await tx.$executeRaw`
        UPDATE public.tax_deadline
           SET request_id = NULL,
               auto_request_notification_status = 'NOT_REQUIRED',
               auto_request_notification_attempt_count = 0,
               auto_request_notification_last_attempt_at = NULL,
               auto_request_notification_next_attempt_at = NULL,
               auto_request_notification_accepted_at = NULL,
               auto_request_notification_last_error = NULL,
               auto_request_notification_escalated_at = NULL
         WHERE id = ${deadlineId}::uuid
      `;
      // Wie ein regulärer Unlink: Historie bleibt als ORPHANED erhalten.
      const [row] = await tx.$queryRaw<Array<{ status: string; attempts: number }>>`
        SELECT auto_request_notification_status::text AS "status",
               auto_request_notification_attempt_count AS "attempts"
          FROM public.tax_deadline WHERE id = ${deadlineId}::uuid
      `;
      expect(row).toEqual({ status: 'ORPHANED', attempts: 1 });
    });
  });

  it('TAX-DEADLINE-AUTOREQUEST-001: Purge-Funktion neutralisiert Pointer tenantgebunden', async () => {
    await asOwnerInRollback(async (tx) => {
      const [foreign] = await tx.$queryRaw<Array<{ count: number }>>`
        SELECT app.purge_tax_deadline_request_links(
                 gen_random_uuid(), ARRAY[${requestId}::uuid], ARRAY[${deadlineId}::uuid]
               ) AS "count"
      `;
      expect(foreign?.count).toBe(0);
      const [purged] = await tx.$queryRaw<Array<{ count: number }>>`
        SELECT app.purge_tax_deadline_request_links(
                 ${tenantId}::uuid, ARRAY[${requestId}::uuid], ARRAY[${deadlineId}::uuid]
               ) AS "count"
      `;
      expect(purged?.count).toBe(1);
      const [row] = await tx.$queryRaw<
        Array<{ requestId: string | null; status: string; attempts: number; flag: string }>
      >`
        SELECT request_id::text AS "requestId",
               auto_request_notification_status::text AS "status",
               auto_request_notification_attempt_count AS "attempts",
               COALESCE(current_setting('app.tax_deadline_notification_purge', true), '') AS "flag"
          FROM public.tax_deadline WHERE id = ${deadlineId}::uuid
      `;
      // Die Freigabe endet mit der Funktion.
      expect(row).toEqual({ requestId: null, status: 'NOT_REQUIRED', attempts: 0, flag: '' });
    });
  });

  it('TAX-DEADLINE-AUTOREQUEST-001: ORPHANED-Herkunft nur über die Funktion löschbar', async () => {
    const orphan = async (tx: Tx) => {
      await tx.$executeRaw`UPDATE public.request SET status = 'CANCELLED' WHERE id = ${requestId}::uuid`;
      await tx.$executeRaw`UPDATE public.tax_deadline SET request_id = NULL WHERE id = ${deadlineId}::uuid`;
      const [row] = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT auto_request_notification_status::text AS "status"
          FROM public.tax_deadline WHERE id = ${deadlineId}::uuid
      `;
      expect(row?.status).toBe('ORPHANED');
    };
    await expect(
      owner.$transaction(async (tx) => {
        await orphan(tx);
        await tx.$queryRaw`SELECT set_config('app.tax_deadline_notification_purge', 'on', true)`;
        await tx.$executeRaw`
          UPDATE public.tax_deadline
             SET auto_request_notification_status = 'NOT_REQUIRED',
                 auto_request_notification_attempt_count = 0,
                 auto_request_notification_last_attempt_at = NULL,
                 auto_request_notification_next_attempt_at = NULL,
                 auto_request_notification_last_error = NULL
           WHERE id = ${deadlineId}::uuid
        `;
        throw ROLLBACK;
      }),
    ).rejects.toThrow(/orphaned.*history is immutable/i);
    await asOwnerInRollback(async (tx) => {
      await orphan(tx);
      const [purged] = await tx.$queryRaw<Array<{ count: number }>>`
        SELECT app.purge_tax_deadline_request_links(
                 ${tenantId}::uuid, ARRAY[${requestId}::uuid], ARRAY[${deadlineId}::uuid]
               ) AS "count"
      `;
      expect(purged?.count).toBe(1);
    });
  });

  it('Purge-Funktion ist für App- und Drill-Rolle gesperrt', async () => {
    await expect(
      app.$queryRaw`
        SELECT app.purge_tax_deadline_request_links(
                 ${tenantId}::uuid, ARRAY[]::uuid[], ARRAY[]::uuid[]
               )
      `,
    ).rejects.toThrow(/permission denied for function purge_tax_deadline_request_links/);
    await expect(drill.$queryRaw`SELECT count(*) FROM public.tenant`).rejects.toThrow(
      /permission denied for table tenant/,
    );
  });
});
