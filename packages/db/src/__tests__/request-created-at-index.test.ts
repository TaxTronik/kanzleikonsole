import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20260801005000_request_tenant_created_at_index/migration.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('Request-Sortierindex', () => {
  it('ist im Prisma-Schema mit absteigendem createdAt modelliert', () => {
    expect(schema).toContain('@@index([tenantId, createdAt(sort: Desc)])');
  });

  it('wird durch eine vorwärts ausführbare Migration angelegt', () => {
    expect(migration).toMatch(
      /CREATE INDEX "request_tenant_id_created_at_idx"\s+ON "request" \("tenant_id", "created_at" DESC\);/,
    );
  });
});
