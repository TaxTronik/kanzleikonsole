// Fachkatalog: ACCESS-TENANT-RLS-001, AUDIT-HASH-CHAIN-001.
// Real PostgreSQL privilege/policy regressions. Every mutation rolls back.
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, requireDatabaseUrl } from '../prisma-adapter';
import { assertRestoreTargetSecurity } from '../restore-security';

const url = requireDatabaseUrl(process.env['DATABASE_URL'], 'DATABASE_URL');
const owner = new PrismaClient({ adapter: createPostgresAdapter(url) });
const createProbe = (target: string) =>
  new PrismaClient({ adapter: createPostgresAdapter(target) });
afterAll(() => owner.$disconnect());

describe('Restore: effective ACLs and tenant RLS are mandatory', () => {
  it('accepts the fully migrated target without changing grants', async () => {
    await expect(assertRestoreTargetSecurity(url, createProbe)).resolves.toBeUndefined();
  });

  it.each([
    'GRANT UPDATE ON audit_log TO taxtronik_app',
    'GRANT DELETE ON audit_log TO taxtronik_app',
    'GRANT UPDATE ON audit_seal TO taxtronik_app',
    'GRANT DELETE ON audit_seal TO taxtronik_app',
    'GRANT UPDATE ON audit_archive TO taxtronik_app',
    'GRANT DELETE ON audit_archive TO taxtronik_app',
    'GRANT DELETE ON document_version TO taxtronik_app',
    'GRANT TRUNCATE ON audit_log TO PUBLIC',
    'GRANT taxtronik TO taxtronik_app WITH INHERIT FALSE, SET TRUE',
    'GRANT EXECUTE ON FUNCTION app.destroy_gwg_check(uuid) TO PUBLIC',
    'REVOKE EXECUTE ON FUNCTION app.current_tenant_id() FROM taxtronik_app, PUBLIC',
    'ALTER TABLE client DISABLE ROW LEVEL SECURITY',
    'ALTER TABLE client NO FORCE ROW LEVEL SECURITY',
    'CREATE TABLE quality3_restore_unprotected (id integer)',
    'CREATE TABLE quality3_restore_partitioned (id integer) PARTITION BY RANGE (id)',
  ])('rejects unsafe effective state: %s', async (mutation) => {
    const rollback = new Error('ROLLBACK_RESTORE_SECURITY_FIXTURE');
    await expect(
      owner.$transaction(async (tx) => {
        // Fixed local statements only; this transaction is always rolled back.
        await tx.$executeRawUnsafe(mutation);
        await expect(
          assertRestoreTargetSecurity(url, () => ({
            $queryRaw: tx.$queryRaw.bind(tx),
            $disconnect: async () => {},
          })),
        ).rejects.toThrow('Dienste nicht starten');
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });

  it('leaves the original privilege and RLS state intact after rolled-back probes', async () => {
    await expect(assertRestoreTargetSecurity(url, createProbe)).resolves.toBeUndefined();
  });
});
