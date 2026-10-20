// Fachkatalog: ACCESS-TENANT-RLS-001, AUDIT-HASH-CHAIN-001, REMINDER-TICKET-001,
// MAIL-OUTBOX-001.
// Real PostgreSQL privilege/policy regressions. Every mutation rolls back,
// including the cluster-wide role changes (ALTER ROLE/GRANT role are transactional).
// The cases that probe MAINTAIN need PostgreSQL 17+ (CI: 18).
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, requireDatabaseUrl } from '../prisma-adapter';
import { assertRestoreRolesPresent, assertRestoreTargetSecurity } from '../restore-security';
import { anwendungAbgewiesen } from '../testing/db-fehler';

const url = requireDatabaseUrl(process.env['DATABASE_URL'], 'DATABASE_URL');
const owner = new PrismaClient({ adapter: createPostgresAdapter(url) });
const createProbe = (target: string) =>
  new PrismaClient({ adapter: createPostgresAdapter(target) });
afterAll(() => owner.$disconnect());

describe('Restore: effective ACLs and tenant RLS are mandatory', () => {
  it('accepts the fully migrated target without changing grants', async () => {
    await expect(assertRestoreTargetSecurity(url, createProbe)).resolves.toBeUndefined();
  });

  // kk-tcms-qual: Jede Mutation nennt den Befund, an dem die Abnahme scheitert.
  // Der frühere gemeinsame Text „Dienste nicht starten“ steht in jeder
  // Ablehnung – auch wenn die Prüfabfrage selbst scheitert (PostgreSQL 16:
  // MAINTAIN unbekannt) – und hätte die Erkennung nicht belegt.
  const INVARIANTS =
    /^Restore-Sicherheitsabnahme fehlgeschlagen: Rollen-\/Grant-\/REVOKE-Invarianten verletzt\. /;
  const RLS_MISSING =
    /^Restore-Sicherheitsabnahme fehlgeschlagen: ENABLE\/FORCE-RLS oder Policies fehlen\. /;
  // PUBLIC gilt auch für die Owner-Rolle: deren Prüfung (B6) greift zuerst.
  const OWNER_PUBLIC =
    /^Restore-Sicherheitsabnahme fehlgeschlagen: Owner-Rolle taxtronik_owner besitzt unzulässige Rechte/;
  it.each<[string, RegExp]>([
    ['GRANT UPDATE ON audit_log TO taxtronik_app', INVARIANTS],
    ['GRANT DELETE ON audit_log TO taxtronik_app', INVARIANTS],
    ['GRANT UPDATE ON audit_seal TO taxtronik_app', INVARIANTS],
    ['GRANT DELETE ON audit_seal TO taxtronik_app', INVARIANTS],
    ['GRANT UPDATE ON audit_archive TO taxtronik_app', INVARIANTS],
    ['GRANT DELETE ON audit_archive TO taxtronik_app', INVARIANTS],
    ['GRANT UPDATE ON audit_anchor TO taxtronik_app', INVARIANTS],
    ['GRANT DELETE ON audit_anchor TO taxtronik_app', INVARIANTS],
    ['GRANT TRUNCATE ON audit_anchor TO PUBLIC', OWNER_PUBLIC],
    ['GRANT INSERT ON audit_verify_checkpoint TO taxtronik_app', INVARIANTS],
    ['GRANT UPDATE ON audit_verify_checkpoint TO taxtronik_app', INVARIANTS],
    ['GRANT DELETE ON audit_verify_checkpoint TO taxtronik_app', INVARIANTS],
    ['GRANT TRUNCATE ON audit_verify_checkpoint TO PUBLIC', OWNER_PUBLIC],
    ['GRANT SELECT ON audit_anchor_lease TO taxtronik_app', INVARIANTS],
    ['GRANT UPDATE ON audit_anchor_lease TO PUBLIC', INVARIANTS],
    // TCMS Stufe 4 (MAIL-OUTBOX-001): Zustelltabellen nur für den Worker (Owner).
    ['GRANT SELECT ON tcms_systemakteur TO taxtronik_app', INVARIANTS],
    ['GRANT UPDATE ON tcms_systemakteur TO PUBLIC', INVARIANTS],
    ['GRANT SELECT ON tcms_nachricht_zustellung TO taxtronik_app', INVARIANTS],
    ['GRANT INSERT ON tcms_nachricht_zustellung TO PUBLIC', INVARIANTS],
    ['GRANT DELETE ON document_version TO taxtronik_app', INVARIANTS],
    ['GRANT TRUNCATE ON audit_log TO PUBLIC', OWNER_PUBLIC],
    ['GRANT taxtronik TO taxtronik_app WITH INHERIT FALSE, SET TRUE', INVARIANTS],
    ['GRANT EXECUTE ON FUNCTION app.destroy_gwg_check(uuid) TO PUBLIC', INVARIANTS],
    ['GRANT SELECT ON client_reminder_counter TO taxtronik_app', INVARIANTS],
    ['GRANT UPDATE ON client_reminder_counter TO taxtronik_app', INVARIANTS],
    ['GRANT TRUNCATE ON client_reminder_counter TO PUBLIC', OWNER_PUBLIC],
    ['GRANT UPDATE ON client_reminder_reference TO taxtronik_app', INVARIANTS],
    ['GRANT DELETE ON client_reminder_reference TO taxtronik_app', INVARIANTS],
    ['GRANT TRUNCATE ON client_reminder_reference TO PUBLIC', OWNER_PUBLIC],
    ['REVOKE SELECT ON client_reminder_reference FROM taxtronik_app', INVARIANTS],
    ['REVOKE INSERT ON client_reminder_reference FROM taxtronik_app', INVARIANTS],
    ['GRANT EXECUTE ON FUNCTION app.allocate_reminder_ticket_number() TO PUBLIC', INVARIANTS],
    ['GRANT EXECUTE ON FUNCTION app.guard_reminder_ticket_identity() TO taxtronik_app', INVARIANTS],
    ['REVOKE EXECUTE ON FUNCTION app.current_tenant_id() FROM taxtronik_app, PUBLIC', INVARIANTS],
    ['ALTER TABLE client DISABLE ROW LEVEL SECURITY', RLS_MISSING],
    ['ALTER TABLE client NO FORCE ROW LEVEL SECURITY', RLS_MISSING],
    ['CREATE TABLE quality3_restore_unprotected (id integer)', RLS_MISSING],
    ['CREATE TABLE quality3_restore_partitioned (id integer) PARTITION BY RANGE (id)', RLS_MISSING],
  ])('rejects unsafe effective state: %s', async (mutation, message) => {
    await expectRejectedAfter(mutation, message);
  });

  // B6 (S-01): the owner role of the containers after pg_restore. These cases
  // run before the 32-invariant probe and therefore also hold on PostgreSQL 16.
  const OWNER_UNSAFE = /Owner-Rolle taxtronik_owner verletzt S-01/;
  const OWNER_EXTRA = /Owner-Rolle taxtronik_owner besitzt unzulässige Rechte/;
  const PRE_S01_DUMP =
    /ohne die Grants der Migration 20261006160000.*mit dem passenden alten Release wiederherstellen und anschließend per \.\/taxtronik update anheben\./;
  it.each([
    ['ALTER ROLE taxtronik_owner SUPERUSER', OWNER_UNSAFE],
    ['ALTER ROLE taxtronik_owner CREATEDB', OWNER_UNSAFE],
    ['ALTER ROLE taxtronik_owner CREATEROLE', OWNER_UNSAFE],
    ['ALTER ROLE taxtronik_owner REPLICATION', OWNER_UNSAFE],
    ['ALTER ROLE taxtronik_owner NOBYPASSRLS', OWNER_UNSAFE],
    ['GRANT taxtronik_app TO taxtronik_owner', OWNER_UNSAFE],
    ['ALTER TABLE client_reminder_counter OWNER TO taxtronik_owner', OWNER_UNSAFE],
    ['GRANT CREATE ON SCHEMA public TO taxtronik_owner', OWNER_UNSAFE],
    ['GRANT CREATE ON SCHEMA app TO taxtronik_owner', OWNER_UNSAFE],
    ['GRANT UPDATE ON audit_log TO taxtronik_owner', OWNER_EXTRA],
    ['GRANT DELETE ON audit_seal TO taxtronik_owner', OWNER_EXTRA],
    ['GRANT TRUNCATE ON audit_anchor TO taxtronik_owner', OWNER_EXTRA],
    ['GRANT DELETE ON audit_archive TO taxtronik_owner', OWNER_EXTRA],
    ['GRANT INSERT ON _prisma_migrations TO taxtronik_owner', OWNER_EXTRA],
    ['GRANT TRUNCATE ON client TO taxtronik_owner', OWNER_EXTRA],
    ['GRANT REFERENCES ON client TO taxtronik_owner', OWNER_EXTRA],
    ['GRANT TRIGGER ON client TO PUBLIC', OWNER_EXTRA],
    [
      `DO $$ BEGIN
         IF current_setting('server_version_num')::int >= 170000 THEN
           EXECUTE 'GRANT MAINTAIN ON client TO taxtronik_owner';
         ELSE
           EXECUTE 'GRANT TRIGGER ON client TO taxtronik_owner';
         END IF;
       END $$`,
      OWNER_EXTRA,
    ],
    ['REVOKE SELECT ON client FROM taxtronik_owner', PRE_S01_DUMP],
    ['REVOKE INSERT ON tenant FROM taxtronik_owner', PRE_S01_DUMP],
    // A dump from before S-01 restores no grant to taxtronik_owner at all.
    ['REVOKE ALL ON ALL TABLES IN SCHEMA public FROM taxtronik_owner', PRE_S01_DUMP],
    [
      'ALTER ROLE taxtronik_owner RENAME TO taxtronik_owner_restore_probe',
      /Owner-Rolle taxtronik_owner fehlt \(S-01\)/,
    ],
  ])('rejects an unsafe owner role after pg_restore: %s', async (mutation, message) => {
    await expectRejectedAfter(mutation, message);
  });

  // Welle 15: pg_db_role_setting ist nicht Teil des Dumps; das Gate verlangt
  // genau die kanonischen Einstellungen (CANONICAL_ROLE_SETTINGS).
  const roleSetting = (statement: string) =>
    `DO $$ BEGIN EXECUTE format('ALTER ROLE ${statement}', current_database()); END $$`;
  it.each([
    [
      roleSetting('taxtronik_app IN DATABASE %I RESET lock_timeout'),
      /Rolleneinstellungen der Ziel-Datenbank weichen ab \(fehlend: taxtronik_app lock_timeout=5s\)/,
    ],
    [
      roleSetting("taxtronik_app IN DATABASE %I SET lock_timeout = ''10s''"),
      /fehlend: taxtronik_app lock_timeout=5s; abweichend oder zusätzlich: taxtronik_app lock_timeout=10s/,
    ],
    [
      roleSetting("taxtronik_app IN DATABASE %I SET statement_timeout = ''1s''"),
      /abweichend oder zusätzlich: taxtronik_app statement_timeout=1s/,
    ],
    [
      roleSetting("taxtronik_owner IN DATABASE %I SET lock_timeout = ''5s''"),
      /abweichend oder zusätzlich: taxtronik_owner lock_timeout=5s/,
    ],
  ])(
    'rejects missing or deviating role settings after pg_restore: %s',
    async (mutation, message) => {
      await expectRejectedAfter(mutation, message);
    },
  );

  it('leaves the original privilege and RLS state intact after rolled-back probes', async () => {
    await expect(assertRestoreTargetSecurity(url, createProbe)).resolves.toBeUndefined();
  });
});

describe('Restore: cluster roles must exist with safe attributes before pg_restore (B6)', () => {
  it('accepts the bootstrapped app and owner roles', async () => {
    await expect(assertRestoreRolesPresent(url, createProbe)).resolves.toBeUndefined();
  });

  it.each([
    ['ALTER ROLE taxtronik_app BYPASSRLS', /taxtronik_app existiert nicht oder besitzt/],
    ['ALTER ROLE taxtronik_app CREATEROLE', /taxtronik_app existiert nicht oder besitzt/],
    ['ALTER ROLE taxtronik_owner SUPERUSER', /taxtronik_owner \(S-01\) besitzt unzulässige/],
    ['ALTER ROLE taxtronik_owner CREATEDB', /taxtronik_owner \(S-01\) besitzt unzulässige/],
    ['ALTER ROLE taxtronik_owner CREATEROLE', /taxtronik_owner \(S-01\) besitzt unzulässige/],
    ['ALTER ROLE taxtronik_owner REPLICATION', /taxtronik_owner \(S-01\) besitzt unzulässige/],
    ['ALTER ROLE taxtronik_owner NOBYPASSRLS', /taxtronik_owner \(S-01\) besitzt unzulässige/],
    ['GRANT taxtronik_app TO taxtronik_owner', /taxtronik_owner \(S-01\) besitzt unzulässige/],
    [
      'ALTER ROLE taxtronik_owner RENAME TO taxtronik_owner_restore_probe',
      /taxtronik_owner \(S-01\) existiert nicht.*vor Migration 20261006160000 \(S-01\) mit dem passenden alten Release/,
    ],
  ])('stops before pg_restore: %s', async (mutation, message) => {
    const rollback = new Error('ROLLBACK_RESTORE_ROLE_FIXTURE');
    await expect(
      owner.$transaction(async (tx) => {
        // Fixed local statements only; this transaction is always rolled back.
        await tx.$executeRawUnsafe(mutation);
        await anwendungAbgewiesen(
          assertRestoreRolesPresent(url, () => ({
            $queryRaw: tx.$queryRaw.bind(tx),
            $disconnect: async () => {},
          })),
          message,
        );
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });

  it('leaves both roles intact after the rolled-back probes', async () => {
    await expect(assertRestoreRolesPresent(url, createProbe)).resolves.toBeUndefined();
  });
});

async function expectRejectedAfter(mutation: string, message: string | RegExp): Promise<void> {
  const rollback = new Error('ROLLBACK_RESTORE_SECURITY_FIXTURE');
  await expect(
    owner.$transaction(async (tx) => {
      // Fixed local statements only; this transaction is always rolled back.
      await tx.$executeRawUnsafe(mutation);
      await anwendungAbgewiesen(
        assertRestoreTargetSecurity(url, () => ({
          $queryRaw: tx.$queryRaw.bind(tx),
          $disconnect: async () => {},
        })),
        message,
      );
      throw rollback;
    }),
  ).rejects.toBe(rollback);
}
