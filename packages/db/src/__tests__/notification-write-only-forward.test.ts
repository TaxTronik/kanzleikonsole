// Fachkatalog: ACCESS-NOTIFICATION-RECIPIENT-001, ACCESS-TENANT-RLS-001.
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { Client as PgClient } from 'pg';
import { describe, expect, it } from 'vitest';

const migrations = new URL('../../prisma/migrations/', import.meta.url);
const portalMigration = '20260824030000_notification_client_contact_insert';
const repairMigration = '20260827100000_reconcile_late_security_guards';
const forwardMigration = '20260830234000_restore_portal_notification_write_only';

function readMigration(name: string): string {
  return readFileSync(new URL(`${name}/migration.sql`, migrations), 'utf8');
}

function insertPolicy(sql: string): string {
  const policy = sql.match(/CREATE POLICY "notification_insert"[\s\S]*?;/)?.[0];
  if (!policy) throw new Error('notification_insert policy is missing from the migration');
  return policy;
}

function withoutTransaction(sql: string): string {
  return sql.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '');
}

async function setActor(
  db: PgClient,
  tenantId: string,
  actorId: string,
  actorType: 'CLIENT_CONTACT' | 'STAFF' | 'SYSTEM',
): Promise<void> {
  await db.query('RESET ROLE');
  await db.query(
    `SELECT set_config('app.current_tenant_id', $1, true),
            set_config('app.current_actor_id', $2, true),
            set_config('app.current_actor_type', $3, true)`,
    [tenantId, actorId, actorType],
  );
  await db.query('SET LOCAL ROLE taxtronik_app');
}

async function expectPrivilegeRejection(
  db: PgClient,
  sql: string,
  parameters: string[],
): Promise<void> {
  await db.query('SAVEPOINT expected_rejection');
  try {
    await expect(db.query(sql, parameters)).rejects.toMatchObject({ code: '42501' });
  } finally {
    await db.query('ROLLBACK TO SAVEPOINT expected_rejection');
    await db.query('RELEASE SAVEPOINT expected_rejection');
  }
}

async function createFixture(db: PgClient) {
  const tenantId = randomUUID();
  const clientId = randomUUID();
  const staffId = randomUUID();
  const contactId = randomUUID();
  const requestId = randomUUID();
  await db.query(
    'INSERT INTO public.tenant (id, slug, name, updated_at) VALUES ($1, $2, $3, NOW())',
    [tenantId, `notification-replay-${tenantId}`, 'Write-only replay fixture'],
  );
  await db.query(
    `INSERT INTO public.staff_user
       (id, tenant_id, email, full_name, password_hash, updated_at)
     VALUES ($1, $2, $3, 'Replay staff', 'test-only-invalid-hash', NOW())`,
    [staffId, tenantId, `${staffId}@test.local`],
  );
  await db.query(
    `INSERT INTO public.client (id, tenant_id, kind, name, updated_at)
     VALUES ($1, $2, 'NATPERS', 'Replay client', NOW())`,
    [clientId, tenantId],
  );
  await db.query(
    `INSERT INTO public.client_contact
       (id, tenant_id, client_id, email, full_name, updated_at)
     VALUES ($1, $2, $3, $4, 'Replay contact', NOW())`,
    [contactId, tenantId, clientId, `${contactId}@test.local`],
  );
  await db.query(
    `INSERT INTO public.appointment_request
       (id, tenant_id, client_id, created_by_contact, subject, proposed_slots)
     VALUES ($1, $2, $3, $4, 'Replay appointment', '[]'::jsonb)`,
    [requestId, tenantId, clientId, contactId],
  );
  return { tenantId, clientId, staffId, contactId, requestId };
}

const rawInsert = `INSERT INTO public.notification
  (tenant_id, client_id, staff_id, kind, title, resource_type, resource_id)
  VALUES ($1::uuid, $2::uuid, $3::uuid, 'APPOINTMENT_REQUESTED',
          $5::text, 'appointment_request', $4::text)`;
const portalUpsert = `SELECT app.upsert_client_contact_notification(
  $1::uuid, $2::uuid, $3::uuid, 'APPOINTMENT_REQUESTED',
  $5::text, NULL, NULL, 'appointment_request', $4::text
) AS accepted`;

describe('Notification write-only forward migration', () => {
  it('läuft nach beiden zusammengeführten Migrationspfaden und erhält exakt die Portalpolicy', () => {
    expect(forwardMigration > portalMigration).toBe(true);
    expect(forwardMigration > repairMigration).toBe(true);
    expect(insertPolicy(readMigration(forwardMigration)).replace(/\s+/g, ' ')).toBe(
      insertPolicy(readMigration(portalMigration)).replace(/\s+/g, ' '),
    );
    expect(insertPolicy(readMigration(repairMigration))).toContain("'CLIENT_CONTACT'");
    expect(insertPolicy(readMigration(forwardMigration))).not.toContain("'CLIENT_CONTACT'");
  });

  it('bleibt die letzte Definition der INSERT-Policy im vollständigen Migrationslauf', () => {
    const policyMigrations = readdirSync(migrations, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .filter((name) => /CREATE POLICY "notification_insert"/.test(readMigration(name)));
    expect(policyMigrations.at(-1)).toBe(forwardMigration);
  });

  it('ändert weder Funktionsrechte noch Lese-, Änderungs-, Löschrechte oder das Ledger', () => {
    const sql = readMigration(forwardMigration).replace(/^--.*$/gm, '');
    expect(sql).toMatch(/\bBEGIN;/);
    expect(sql).toMatch(/\bCOMMIT;/);
    expect(sql.match(/DROP POLICY/g)).toHaveLength(1);
    expect(sql.match(/CREATE POLICY/g)).toHaveLength(1);
    expect(sql).not.toMatch(/CREATE (?:OR REPLACE )?FUNCTION|GRANT|REVOKE|_prisma_migrations/);
    expect(sql).not.toMatch(/FOR SELECT|FOR UPDATE|FOR DELETE/);
  });

  it('sperrt Raw-INSERT nach dem Reparatur-Replay und erhält write-only Upsert und Staffzugriff', async () => {
    const db = new PgClient({ connectionString: process.env['DATABASE_URL'] });
    await db.connect();
    try {
      // All fixtures and DDL are local to this transaction and always rolled
      // back. No temporarily weaker policy becomes visible to another session.
      await db.query('BEGIN');
      await db.query("SET LOCAL lock_timeout = '5s'");
      await db.query("SET LOCAL statement_timeout = '10s'");
      const fixture = await createFixture(db);
      const { tenantId, clientId, staffId, contactId, requestId } = fixture;
      const parameters = [tenantId, clientId, staffId, requestId, 'Portal original'];

      await db.query('DROP POLICY "notification_insert" ON public.notification');
      await db.query(insertPolicy(readMigration(repairMigration)));
      await setActor(db, tenantId, contactId, 'CLIENT_CONTACT');
      // Reproduce the actual merge-order regression before applying the fix.
      expect((await db.query(rawInsert, parameters)).rowCount).toBe(1);
      expect((await db.query('SELECT id FROM public.notification')).rows).toEqual([]);
      await db.query('RESET ROLE');
      await db.query('DELETE FROM public.notification WHERE tenant_id = $1', [tenantId]);

      const functionBefore = await db.query(
        `SELECT pg_get_functiondef(oid) AS definition FROM pg_proc
         WHERE pronamespace = 'app'::regnamespace
           AND proname = 'upsert_client_contact_notification'`,
      );
      expect(functionBefore.rows).toHaveLength(1);
      await db.query(withoutTransaction(readMigration(forwardMigration)));
      const functionAfter = await db.query(
        `SELECT pg_get_functiondef(oid) AS definition FROM pg_proc
         WHERE pronamespace = 'app'::regnamespace
           AND proname = 'upsert_client_contact_notification'`,
      );
      expect(functionAfter.rows).toEqual(functionBefore.rows);

      await setActor(db, tenantId, contactId, 'CLIENT_CONTACT');
      await expectPrivilegeRejection(db, rawInsert, parameters);
      expect((await db.query(portalUpsert, parameters)).rows).toEqual([{ accepted: true }]);
      expect(
        (await db.query(portalUpsert, [...parameters.slice(0, 4), 'Must not replace'])).rows,
      ).toEqual([{ accepted: true }]);
      expect((await db.query('SELECT id FROM public.notification')).rows).toEqual([]);
      expect(
        (await db.query('UPDATE public.notification SET title = $1', ['Must not change'])).rowCount,
      ).toBe(0);
      expect((await db.query('DELETE FROM public.notification')).rowCount).toBe(0);

      await setActor(db, tenantId, staffId, 'STAFF');
      expect((await db.query('SELECT title FROM public.notification')).rows).toEqual([
        { title: 'Portal original' },
      ]);
      expect(
        (await db.query(rawInsert, [...parameters.slice(0, 4), 'Staff original'])).rowCount,
      ).toBe(1);
      await setActor(db, tenantId, staffId, 'SYSTEM');
      expect(
        (await db.query(rawInsert, [...parameters.slice(0, 4), 'System original'])).rowCount,
      ).toBe(1);
    } finally {
      try {
        await db.query('ROLLBACK');
      } finally {
        await db.end();
      }
    }
  });
});
