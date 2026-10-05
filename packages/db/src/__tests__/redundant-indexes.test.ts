// Fachkatalog: AUDIT-HASH-CHAIN-001
// Fachkatalog: TAX-CONTROL-STATUS-001
//
// Review-Finding D-06: Kein B-Tree-Index darf vollständig von einem anderen
// gedeckt sein (gleiche führende Spalten, Operatorklasse und Collation, ohne
// Prädikat/Ausdruck, selbst nicht eindeutig). Einzige dokumentierte Ausnahme:
// gwg_representative_gwg_check_id_idx, den die GwG-Invariante 043 verlangt.
import { readFileSync } from 'node:fs';

import { afterAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';

const KEPT_FOR_GWG_INVARIANT = 'gwg_representative_gwg_check_id_idx';

const REDUNDANT_INDEXES_SQL = `
  WITH ix AS (
    SELECT i.indexrelid, i.indrelid, c.relname::text AS name, i.indisunique, i.indisprimary,
           (i.indpred IS NOT NULL) AS partial, (i.indexprs IS NOT NULL) AS expr, am.amname,
           (i.indkey::int2[])[0:i.indnkeyatts - 1] AS keys,
           (i.indclass::oid[])[0:i.indnkeyatts - 1] AS opclasses,
           (i.indcollation::oid[])[0:i.indnkeyatts - 1] AS collations,
           EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.indexrelid) AS backs_constraint
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
      JOIN pg_am am ON am.oid = c.relam
  )
  SELECT DISTINCT a.name
    FROM ix a
    JOIN ix b ON b.indrelid = a.indrelid AND b.indexrelid <> a.indexrelid
   WHERE a.amname = 'btree' AND b.amname = 'btree'
     AND NOT a.partial AND NOT a.expr AND NOT b.partial AND NOT b.expr
     AND NOT a.indisprimary AND NOT a.indisunique AND NOT a.backs_constraint
     AND cardinality(a.keys) <= cardinality(b.keys)
     AND a.keys = b.keys[1:cardinality(a.keys)]
     AND a.opclasses = b.opclasses[1:cardinality(a.keys)]
     AND a.collations = b.collations[1:cardinality(a.keys)]
   ORDER BY a.name`;

const invariant = readFileSync(
  new URL('../../invariants/gwg/043-identity-subjects-and-document-sets.sql', import.meta.url),
  'utf8',
);

describe('Redundante Indizes: Ausnahme', () => {
  it('besteht nur, solange die GwG-Invariante den Index verlangt', () => {
    expect(invariant).toContain(`('${KEPT_FOR_GWG_INVARIANT}')`);
  });
});

const hasDatabase = Boolean(process.env['DATABASE_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('Index-Redundanztest braucht DATABASE_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});

afterAll(async () => {
  await owner.$disconnect();
});

describeWithDatabase('Redundante Indizes: migrierte Datenbank', () => {
  it('enthält keinen vollständig gedeckten B-Tree-Index außer der GwG-Ausnahme', async () => {
    const rows = await owner.$queryRawUnsafe<Array<{ name: string }>>(REDUNDANT_INDEXES_SQL);
    expect(rows.map((row) => row.name)).toEqual([KEPT_FOR_GWG_INVARIANT]);
  });

  it('behält die deckenden Unique-Indizes der entfernten Indizes', async () => {
    const covering = [
      'audit_seal_tenant_id_seal_date_key',
      'deadline_daily_review_tenant_date_key',
      'document_version_document_id_version_no_key',
      'staff_user_tenant_id_id_key',
      'client_tenant_id_id_key',
      'tax_filing_tenant_client_kind_period_key',
    ];
    const rows = await owner.$queryRaw<Array<{ name: string; unique: boolean }>>`
      SELECT c.relname::text AS name, i.indisunique AS unique
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relname = ANY (${covering}::text[])
       ORDER BY c.relname
    `;
    expect(rows).toEqual([...covering].sort().map((name) => ({ name, unique: true })));
  });
});
