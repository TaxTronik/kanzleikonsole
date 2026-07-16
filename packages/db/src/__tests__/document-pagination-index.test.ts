import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20260801006000_document_client_deleted_created_index/migration.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('Document-Paginierungsindex', () => {
  it('deckt Zustand und stabile Cockpit-Sortierung im Prisma-Schema ab', () => {
    expect(schema).toContain(
      '@@index([clientId, deletedAt, createdAt(sort: Desc), id(sort: Desc)])',
    );
  });

  it('wird vorwärtskompatibel mit beiden Sortierspalten angelegt', () => {
    expect(migration).toMatch(
      /CREATE INDEX "document_client_id_deleted_at_created_at_id_idx"\s+ON "document" \("client_id", "deleted_at", "created_at" DESC, "id" DESC\);/,
    );
  });
});
