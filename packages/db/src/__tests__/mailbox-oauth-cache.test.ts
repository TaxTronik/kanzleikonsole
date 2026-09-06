// Fachkatalog: MAIL-INBOX-001
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../prisma-client';
import type { Prisma } from '@prisma/client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_URL)),
});
const app = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_APP_URL)),
});
let tenantId: string, staffId: string, mailboxId: string;
let persist: (
  tx: Prisma.TransactionClient,
  tenant: string,
  staff: string,
  mailbox: string,
  cache: string,
) => Promise<void>;
const save = (cache: string) =>
  app.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant_id',${tenantId},true),set_config('app.current_actor_id',${staffId},true),set_config('app.current_actor_type','STAFF',true)`;
    await persist(tx, tenantId, staffId, mailboxId, cache);
  });
describe('Microsoft OAuth cache current database authorization', () => {
  beforeAll(async () => {
    const helperPath = new URL(
      '../../../../apps/web/src/server/mailbox/oauth-cache.ts',
      import.meta.url,
    ).href;
    persist = (await import(helperPath)).persistMicrosoftOauthCacheTx;
    const suffix = Date.now() + '-' + Math.random();
    tenantId = (
      await owner.tenant.create({
        data: { name: 'Synthetic OAuth cache', slug: 'oauth-cache-' + suffix },
      })
    ).id;
    staffId = (
      await owner.staffUser.create({
        data: {
          tenantId,
          email: suffix + '@example.test',
          fullName: 'Synthetic admin',
          passwordHash: 'synthetic',
          roles: { create: { role: 'ADMIN' } },
        },
      })
    ).id;
    await owner.tenantSetting.create({
      data: { tenantId, key: 'modules', value: { smartMailbox: true } },
    });
    mailboxId = (
      await owner.inboundMailbox.create({
        data: {
          tenantId,
          provider: 'MICROSOFT365',
          name: 'Synthetic mailbox',
          host: 'outlook.office365.com',
          username: 'synthetic@example.test',
        },
      })
    ).id;
  });
  afterAll(async () => {
    if (tenantId) {
      await owner.inboundMailbox.deleteMany({ where: { tenantId } });
      await owner.tenantSetting.deleteMany({ where: { tenantId } });
      if (staffId) await owner.staffRole.deleteMany({ where: { staffUserId: staffId } });
      await owner.staffUser.deleteMany({ where: { tenantId } });
      await owner.tenant.delete({ where: { id: tenantId } });
    }
    await Promise.all([owner.$disconnect(), app.$disconnect()]);
  });
  it('persists for a fresh admin but preserves prior ciphertext after role or module revocation', async () => {
    await save('synthetic-encrypted-initial');
    await owner.staffRole.deleteMany({ where: { staffUserId: staffId } });
    await expect(save('synthetic-encrypted-revoked-role')).rejects.toThrow('authorization changed');
    await owner.staffRole.create({ data: { staffUserId: staffId, role: 'ADMIN' } });
    await owner.tenantSetting.update({
      where: { tenantId_key: { tenantId, key: 'modules' } },
      data: { value: { smartMailbox: false } },
    });
    await expect(save('synthetic-encrypted-disabled-module')).rejects.toThrow(
      'authorization changed',
    );
    expect(
      (await owner.inboundMailbox.findUnique({ where: { id: mailboxId } }))?.oauthCacheEnc,
    ).toBe('synthetic-encrypted-initial');
  });
});
