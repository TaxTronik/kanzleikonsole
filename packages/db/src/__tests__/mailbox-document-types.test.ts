// Fachkatalog: MAIL-INBOX-001
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_URL)),
});
let loadMailboxDocumentTypesTx: (
  tx: Prisma.TransactionClient,
  tenantId: string,
) => Promise<Array<{ id: string; name: string }>>;

beforeAll(async () => {
  const helperPath = new URL(
    '../../../../apps/web/src/server/mailbox/document-types.ts',
    import.meta.url,
  ).href;
  ({ loadMailboxDocumentTypesTx } = await import(helperPath));
});

afterAll(() => owner.$disconnect());

describe('MAIL-INBOX-001: Dokumenttypen für die bestätigte Mailbox-Ablage', () => {
  it('bietet eigene NULL-Typen an und hält Mandanten-, Aktivitäts- und Schutzgrenzen ein', async () => {
    const rollback = new Error('rollback mailbox document-type fixture');
    const result = owner.$transaction(async (tx) => {
      const seed = crypto.randomUUID();
      const tenant = await tx.tenant.create({
        data: { name: 'Mailbox document types', slug: `mailbox-types-${seed}` },
      });
      const foreign = await tx.tenant.create({
        data: { name: 'Foreign mailbox types', slug: `mailbox-types-foreign-${seed}` },
      });
      await tx.documentType.createMany({
        data: [
          { tenantId: tenant.id, name: 'Eigener Typ', tier: 'NONE', sortOrder: 2 },
          {
            tenantId: tenant.id,
            name: 'Eigener Belegtyp',
            tier: 'GOBD',
            retentionYears: 8,
            sortOrder: 1,
          },
          {
            tenantId: tenant.id,
            name: 'Allgemein',
            tier: 'NONE',
            builtin: true,
            classificationKey: 'GENERAL',
            sortOrder: 3,
          },
          { tenantId: tenant.id, name: 'Inaktiv', tier: 'NONE', active: false },
          { tenantId: tenant.id, name: 'Eigener GwG-Typ', tier: 'GWG', retentionYears: 5 },
          {
            tenantId: tenant.id,
            name: 'GwG',
            tier: 'GWG',
            retentionYears: 5,
            classificationKey: 'GWG_ID',
          },
          {
            tenantId: tenant.id,
            name: 'Privat',
            tier: 'NONE',
            classificationKey: 'STAFF_PRIVATE',
          },
          {
            tenantId: tenant.id,
            name: 'Personal',
            tier: 'GOBD',
            retentionYears: 8,
            classificationKey: 'PERSONNEL',
          },
          { tenantId: foreign.id, name: 'Fremder eigener Typ', tier: 'NONE' },
        ],
      });

      const available = await loadMailboxDocumentTypesTx(tx, tenant.id);

      expect(available.map((type) => type.name)).toEqual([
        'Eigener Belegtyp',
        'Eigener Typ',
        'Allgemein',
      ]);
      expect(available.every((type) => Object.keys(type).sort().join(',') === 'id,name')).toBe(
        true,
      );
      throw rollback;
    });
    await expect(result).rejects.toBe(rollback);
  });
});
