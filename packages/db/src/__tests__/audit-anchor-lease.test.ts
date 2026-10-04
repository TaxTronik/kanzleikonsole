// Fachkatalog: AUDIT-RFC3161-ANCHOR-001
// Fachkatalog: ACCESS-TENANT-RLS-001
// P-05: Der Tenant-Lease des Rolling-Anchor-Workers ist owner-only. Ein von der
// App-Rolle gesetzter Lease könnte die externe Verankerung eines Tenants
// blockieren; deshalb erhält sie keinerlei Tabellenrechte, RLS ist erzwungen.
import { readFileSync } from 'node:fs';

import { afterAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';

const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20261004140100_audit_anchor_lease/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const migrationSql = migration.replace(/--.*$/gm, '');

describe('Anchor-Lease: Migration', () => {
  it('entzieht der App-Rolle alle Rechte und erzwingt RLS', () => {
    expect(migrationSql).toContain(
      'REVOKE ALL ON TABLE public."audit_anchor_lease" FROM taxtronik_app;',
    );
    expect(migrationSql).toContain('REVOKE ALL ON TABLE public."audit_anchor_lease" FROM PUBLIC;');
    expect(migrationSql).not.toMatch(/\bGRANT\b/);
    expect(migrationSql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migrationSql).toContain('FORCE ROW LEVEL SECURITY');
  });
});

const hasDatabase = Boolean(process.env['DATABASE_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('Anchor-Lease-Test braucht DATABASE_URL in CI.');
}

(hasDatabase ? describe : describe.skip)('Anchor-Lease: Rechte (PostgreSQL)', () => {
  const owner = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
  });
  afterAll(() => owner.$disconnect());

  it('gewährt der App-Rolle keine Rechte und erzwingt RLS mit Tenant-Policy', async () => {
    const rows = await owner.$queryRaw<
      Array<{ granted: boolean; rls: boolean; forced: boolean; policies: number }>
    >`
      SELECT
        has_table_privilege('taxtronik_app', 'public.audit_anchor_lease',
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS granted,
        c.relrowsecurity AS rls,
        c.relforcerowsecurity AS forced,
        (SELECT count(*)::int FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_catalog.pg_class c
      WHERE c.oid = 'public.audit_anchor_lease'::regclass
    `;
    expect(rows).toEqual([{ granted: false, rls: true, forced: true, policies: 1 }]);
  });
});
