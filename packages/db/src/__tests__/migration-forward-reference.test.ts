import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration034 = readFileSync(
  new URL(
    '../../prisma/migrations/20260801003400_gwg_fail_closed_and_destruction/migration.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('GwG migration 034 forward references', () => {
  it('resolves destruction functions fail-closed until they are created', () => {
    expect(migration034).not.toMatch(
      /'app\.destroy_gwg_(?:check|document_versions)\(uuid\)'::regprocedure/,
    );

    const safeLookups = migration034.match(
      /pg_catalog\.to_regprocedure\('app\.destroy_gwg_(?:check|document_versions)\(uuid\)'\)/g,
    );
    expect(safeLookups).toHaveLength(7);
  });
});
