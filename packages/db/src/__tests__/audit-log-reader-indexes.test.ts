// Fachkatalog: AUDIT-HASH-CHAIN-001
// Fachkatalog: TCMS-SAMPLE-PROOF-001
// Fachkatalog: DSGVO-CONTACT-EXPORT-001
//
// Review-Finding P-11: Fachliche Leser filtern audit_log nach action bzw. Akteur.
// Die Spaltenreihenfolge der Akteur-Indizes folgt daraus, welche Vergleiche
// PostgreSQL unter RLS als Indexbedingung nutzen darf (nur LEAKPROOF).
import { readFileSync } from 'node:fs';

import { afterAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';

const INDEXES = {
  audit_log_tenant_id_action_id_idx:
    'CREATE INDEX audit_log_tenant_id_action_id_idx ON public.audit_log USING btree (tenant_id, action, id)',
  audit_log_tenant_id_actor_id_actor_type_idx:
    'CREATE INDEX audit_log_tenant_id_actor_id_actor_type_idx ON public.audit_log USING btree (tenant_id, actor_id, actor_type)',
} as const;

const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20261005100200_audit_log_action_actor_indexes/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');

describe('audit_log-Leserindizes: Migration und Schema', () => {
  it('legt beide Indizes an und führt sie im Prisma-Schema', () => {
    expect(migration).toMatch(
      /CREATE INDEX "audit_log_tenant_id_action_id_idx"\s+ON "audit_log" \("tenant_id", "action", "id"\);/,
    );
    expect(migration).toMatch(
      /CREATE INDEX "audit_log_tenant_id_actor_id_actor_type_idx"\s+ON "audit_log" \("tenant_id", "actor_id", "actor_type"\);/,
    );
    const auditModel = schema.slice(schema.indexOf('model AuditLog {'));
    const block = auditModel.slice(0, auditModel.indexOf('\n}'));
    expect(block).toContain('@@index([tenantId, action, id])');
    expect(block).toContain('@@index([tenantId, actorId, actorType])');
  });
});

const hasDatabase = Boolean(process.env['DATABASE_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('audit_log-Indextest braucht DATABASE_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});

afterAll(async () => {
  await owner.$disconnect();
});

describeWithDatabase('audit_log-Leserindizes: Datenbank', () => {
  it('existieren mit der dokumentierten Spaltenreihenfolge', async () => {
    const rows = await owner.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'audit_log'
         AND indexname IN ('audit_log_tenant_id_action_id_idx',
                           'audit_log_tenant_id_actor_id_actor_type_idx')
       ORDER BY indexname
    `;
    expect(Object.fromEntries(rows.map((row) => [row.indexname, row.indexdef]))).toEqual(INDEXES);
  });

  it('stützt die Reihenfolge: unter RLS sind nur UUID- und Textvergleich LEAKPROOF', async () => {
    // Ändert PostgreSQL das, ist (tenant_id, actor_type, actor_id) neu zu bewerten.
    const rows = await owner.$queryRaw<Array<{ proname: string; proleakproof: boolean }>>`
      SELECT proname, proleakproof FROM pg_proc
       WHERE proname IN ('enum_eq', 'uuid_eq', 'texteq')
         AND pronamespace = 'pg_catalog'::regnamespace
       ORDER BY proname
    `;
    expect(rows).toEqual([
      { proname: 'enum_eq', proleakproof: false },
      { proname: 'texteq', proleakproof: true },
      { proname: 'uuid_eq', proleakproof: true },
    ]);
  });
});
