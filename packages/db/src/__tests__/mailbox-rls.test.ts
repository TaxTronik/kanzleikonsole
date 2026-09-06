// Fachkatalog: MAIL-INBOX-001
// Fachkatalog: ACCESS-STAFF-PERMISSION-001
// Fachkatalog: DOC-PORTAL-SHARING-001
// Fachkatalog: ACCESS-TENANT-RLS-001
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { PrismaClient } from '../prisma-client';
import type { Prisma } from '@prisma/client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_URL)),
});
const app = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_APP_URL)),
});
let tid: string,
  otherTid: string,
  staff: string,
  denied: string,
  mailbox: string,
  message: string,
  attachment: string,
  protectedDocument: string;
async function asActor<T>(
  tenant: string,
  actor: string,
  type: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return app.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant_id',${tenant},true),set_config('app.current_actor_id',${actor},true),set_config('app.current_actor_type',${type},true)`;
    return fn(tx);
  });
}
describe('mailbox storage authorization', () => {
  beforeAll(async () => {
    const seed = Date.now() + '-' + Math.random();
    tid = (await owner.tenant.create({ data: { name: 'Mailbox RLS', slug: 'mailbox-' + seed } }))
      .id;
    otherTid = (
      await owner.tenant.create({
        data: { name: 'Other mailbox RLS', slug: 'mailbox-other-' + seed },
      })
    ).id;
    for (const who of ['staff', 'denied']) {
      const row = await owner.staffUser.create({
        data: {
          tenantId: tid,
          email: who + seed + '@example.test',
          fullName: who,
          passwordHash: 'synthetic',
          roles: { create: { role: 'EMPLOYEE' } },
        },
      });
      if (who === 'staff') staff = row.id;
      else denied = row.id;
    }
    await owner.staffPermission.create({
      data: { staffUserId: staff, permission: 'INBOUND_MAIL_MANAGE', grantedBy: staff },
    });
    mailbox = (
      await owner.inboundMailbox.create({
        data: {
          tenantId: tid,
          name: 'Test',
          host: 'mail.example.test',
          username: 'inbox@example.test',
        },
      })
    ).id;
    message = (
      await owner.inboundMessage.create({ data: { mailboxId: mailbox, uidValidity: '1', uid: 10 } })
    ).id;
    protectedDocument = (
      await owner.document.create({
        data: {
          tenantId: tid,
          ownerStaffId: staff,
          title: 'Private payroll output',
          classification: 'GENERAL',
          mimeType: 'application/pdf',
          requiresPayrollAccess: true,
        },
      })
    ).id;
    attachment = (
      await owner.inboundAttachment.create({
        data: {
          messageId: message,
          part: 0,
          filename: 'synthetic.pdf',
          mimeType: 'application/pdf',
          sha256: 'a'.repeat(64),
          sizeBytes: 100,
          status: 'CLEAN',
        },
      })
    ).id;
  });
  afterAll(async () => {
    if (tid) {
      await owner.document.deleteMany({ where: { id: protectedDocument } });
      await owner.inboundAttachment.deleteMany({ where: { messageId: message } });
      await owner.inboundMessage.deleteMany({ where: { mailboxId: mailbox } });
      await owner.inboundMailbox.deleteMany({ where: { tenantId: tid } });
      await owner.staffPermission.deleteMany({ where: { staffUserId: staff } });
      await owner.staffRole.deleteMany({ where: { staffUserId: { in: [staff, denied] } } });
      await owner.staffUser.deleteMany({ where: { tenantId: tid } });
      await owner.tenant.deleteMany({ where: { id: { in: [tid, otherTid] } } });
    }
    await app.$disconnect();
    await owner.$disconnect();
  });
  it('requires the additional mailbox permission even within the tenant', async () => {
    expect(await asActor(tid, staff, 'STAFF', (tx) => tx.inboundMessage.count())).toBe(1);
    expect(await asActor(tid, denied, 'STAFF', (tx) => tx.inboundMessage.count())).toBe(0);
  });
  it('denies portal identities and foreign tenants including direct attachment lookup', async () => {
    expect(
      await asActor(tid, staff, 'CLIENT_CONTACT', (tx) =>
        tx.inboundAttachment.findUnique({ where: { id: attachment } }),
      ),
    ).toBeNull();
    expect(
      await asActor(otherTid, staff, 'STAFF', (tx) =>
        tx.inboundAttachment.findUnique({ where: { id: attachment } }),
      ),
    ).toBeNull();
  });
  it('cannot claim a scanner verdict or rewrite immutable original hashes', async () => {
    await expect(
      asActor(tid, staff, 'STAFF', (tx) =>
        tx.inboundAttachment.update({
          where: { id: attachment },
          data: { status: 'CLEAN', sha256: 'b'.repeat(64) },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      asActor(tid, staff, 'STAFF', (tx) =>
        tx.inboundAttachment.update({ where: { id: attachment }, data: { status: 'BLOCKED' } }),
      ),
    ).rejects.toThrow();
  });
  it('binds security-definer helpers to the caller tenant and actor', async () => {
    expect(
      await asActor(
        otherTid,
        staff,
        'STAFF',
        async (tx) =>
          (
            await tx.$queryRaw<
              Array<{ allowed: boolean }>
            >`SELECT app.expansion_staff_permission(${tid}::uuid,${staff}::uuid,'INBOUND_MAIL_MANAGE') AS allowed`
          )[0]?.allowed,
      ),
    ).toBe(false);
    expect(
      await asActor(
        tid,
        denied,
        'STAFF',
        async (tx) =>
          (
            await tx.$queryRaw<
              Array<{ allowed: boolean }>
            >`SELECT app.expansion_staff_permission(${tid}::uuid,${staff}::uuid,'INBOUND_MAIL_MANAGE') AS allowed`
          )[0]?.allowed,
      ),
    ).toBe(false);
    expect(
      await asActor(
        otherTid,
        staff,
        'STAFF',
        async (tx) =>
          (
            await tx.$queryRaw<
              Array<{ allowed: boolean }>
            >`SELECT app.document_payroll_scope_allowed(${tid}::uuid,${protectedDocument}) AS allowed`
          )[0]?.allowed,
      ),
    ).toBe(false);
  });
  it('restricts payroll archives and disallows declassification or generic portal sharing', async () => {
    expect(
      await asActor(tid, staff, 'STAFF', (tx) =>
        tx.document.findUnique({ where: { id: protectedDocument } }),
      ),
    ).toBeNull();
    await owner.staffPermission.create({
      data: { staffUserId: staff, permission: 'PAYROLL_MANAGE', grantedBy: staff },
    });
    expect(
      (
        await asActor(tid, staff, 'STAFF', (tx) =>
          tx.document.findUnique({ where: { id: protectedDocument } }),
        )
      )?.id,
    ).toBe(protectedDocument);
    await expect(
      asActor(tid, staff, 'STAFF', (tx) =>
        tx.document.update({
          where: { id: protectedDocument },
          data: { requiresPayrollAccess: false },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      asActor(tid, staff, 'STAFF', (tx) =>
        tx.document.update({
          where: { id: protectedDocument },
          data: { sharedWithClientAt: new Date() },
        }),
      ),
    ).rejects.toThrow();
    expect(
      await asActor(tid, staff, 'CLIENT_CONTACT', (tx) =>
        tx.document.findUnique({ where: { id: protectedDocument } }),
      ),
    ).toBeNull();
    await owner.staffPermission.deleteMany({
      where: { staffUserId: staff, permission: 'PAYROLL_MANAGE' },
    });
    expect(
      await asActor(tid, staff, 'STAFF', (tx) =>
        tx.document.findUnique({ where: { id: protectedDocument } }),
      ),
    ).toBeNull();
  });
  it('does not admit duplicate transport receipts', async () => {
    await expect(
      owner.inboundMessage.create({ data: { mailboxId: mailbox, uidValidity: '1', uid: 10 } }),
    ).rejects.toThrow();
  });
  it('cannot erase durable receipts through bootstrap default DELETE privileges', async () => {
    await expect(
      asActor(tid, staff, 'STAFF', (tx) =>
        tx.inboundAttachment.delete({ where: { id: attachment } }),
      ),
    ).rejects.toThrow();
    await expect(
      asActor(tid, staff, 'STAFF', (tx) => tx.inboundMessage.delete({ where: { id: message } })),
    ).rejects.toThrow();
    await expect(
      asActor(tid, staff, 'STAFF', (tx) => tx.inboundMailbox.delete({ where: { id: mailbox } })),
    ).rejects.toThrow();
    expect(await asActor(tid, staff, 'STAFF', (tx) => tx.inboundMessage.count())).toBe(1);
  });
});
