// Fachkatalog: MAIL-INBOX-001
// Fachkatalog: BWA-PROJECTION-001
//
// Review-Finding D-07: inbound_message.status und bwa_plan.status nehmen nur
// die Werte an, die der Code schreibt (packages/mail/src/imap.ts bzw.
// CreateBwaPlanSchema/UpdateBwaPlanSchema in apps/web/src/server/bwa/plans.ts),
// ebenso inbound_attachment.status (imap.ts und die Archivübernahme in
// apps/web/src/app/staff/(protected)/mailbox/actions.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('Status-CHECK-Test braucht DATABASE_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});

let tenantId: string | undefined;
let mailboxId: string;
let messageId: string;
let attachmentId: string;
let planId: string;

afterAll(async () => {
  if (tenantId) {
    await owner.inboundAttachment.deleteMany({ where: { message: { mailboxId } } });
    await owner.inboundMessage.deleteMany({ where: { mailboxId } });
    await owner.inboundMailbox.deleteMany({ where: { tenantId } });
    await owner.bwaPlan.deleteMany({ where: { tenantId } });
    await owner.client.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
  }
  await owner.$disconnect();
});

describeWithDatabase('Status-CHECKs ohne Enum (D-07)', () => {
  beforeAll(async () => {
    const seed = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    tenantId = (
      await owner.tenant.create({ data: { name: 'Status-CHECK', slug: `status-check-${seed}` } })
    ).id;
    const clientId = (
      await owner.client.create({ data: { tenantId, kind: 'NATPERS', name: 'Status-CHECK' } })
    ).id;
    mailboxId = (
      await owner.inboundMailbox.create({
        data: { tenantId, name: 'Status', host: 'mail.example.test', username: 'in@example.test' },
      })
    ).id;
    // Ohne status: die Defaults PENDING bzw. DRAFT müssen den CHECK erfüllen.
    const message = await owner.inboundMessage.create({
      data: { mailboxId, uidValidity: '1', uid: 1 },
    });
    messageId = message.id;
    expect(message.status).toBe('PENDING');
    const attachment = await owner.inboundAttachment.create({
      data: {
        messageId,
        part: 0,
        filename: 'beleg.pdf',
        mimeType: 'application/pdf',
        sha256: 'a'.repeat(64),
        sizeBytes: 1,
      },
    });
    attachmentId = attachment.id;
    expect(attachment.status).toBe('PENDING');
    const plan = await owner.bwaPlan.create({
      data: {
        tenantId,
        clientId,
        name: 'Plan',
        year: 2026,
        createdBy: clientId,
        createdByType: 'CLIENT_CONTACT',
      },
    });
    planId = plan.id;
    expect(plan.status).toBe('DRAFT');
  });

  it('prüft genau die geschriebenen Werte und ist validiert', async () => {
    const rows = await owner.$queryRaw<Array<{ name: string; def: string; validated: boolean }>>`
      SELECT conname::text AS name, pg_get_constraintdef(oid) AS def, convalidated AS validated
        FROM pg_constraint
       WHERE conname IN (
         'inbound_message_status_check',
         'inbound_attachment_status_check',
         'bwa_plan_status_check'
       )
       ORDER BY conname
    `;
    expect(rows).toEqual([
      {
        name: 'bwa_plan_status_check',
        def: "CHECK ((status = ANY (ARRAY['DRAFT'::text, 'FINAL'::text])))",
        validated: true,
      },
      {
        name: 'inbound_attachment_status_check',
        def:
          "CHECK ((status = ANY (ARRAY['PENDING'::text, 'SCAN_ERROR'::text, 'BLOCKED'::text, " +
          "'CLEAN'::text, 'IMPORTING'::text, 'IMPORTED'::text])))",
        validated: true,
      },
      {
        name: 'inbound_message_status_check',
        def: "CHECK ((status = ANY (ARRAY['PENDING'::text, 'BLOCKED'::text, 'COMPLETE'::text])))",
        validated: true,
      },
    ]);
  });

  it('nimmt die Status des IMAP-Abrufs an und weist andere ab', async () => {
    for (const status of ['BLOCKED', 'COMPLETE', 'PENDING']) {
      await owner.inboundMessage.update({ where: { id: messageId }, data: { status } });
    }
    for (const status of ['DONE', 'complete', '']) {
      await expect(
        owner.$executeRaw`UPDATE inbound_message SET status = ${status} WHERE id = ${messageId}::uuid`,
      ).rejects.toThrow(/inbound_message_status_check/);
    }
    const row = await owner.inboundMessage.findUniqueOrThrow({ where: { id: messageId } });
    expect(row.status).toBe('PENDING');
  });

  it('nimmt die Anhangstatus von IMAP-Abruf und Archivübernahme an und weist andere ab', async () => {
    for (const status of ['SCAN_ERROR', 'BLOCKED', 'CLEAN', 'IMPORTING', 'IMPORTED', 'PENDING']) {
      await owner.inboundAttachment.update({ where: { id: attachmentId }, data: { status } });
    }
    for (const status of ['DONE', 'clean', 'INFECTED', '']) {
      await expect(
        owner.$executeRaw`UPDATE inbound_attachment SET status = ${status} WHERE id = ${attachmentId}::uuid`,
      ).rejects.toThrow(/inbound_attachment_status_check/);
    }
    await expect(
      owner.$executeRaw`
        INSERT INTO inbound_attachment (message_id, part, filename, mime_type, sha256, size_bytes, status)
        VALUES (${messageId}::uuid, 1, 'x.pdf', 'application/pdf', ${'b'.repeat(64)}, 1, 'QUARANTINE')
      `,
    ).rejects.toThrow(/inbound_attachment_status_check/);
    const row = await owner.inboundAttachment.findUniqueOrThrow({ where: { id: attachmentId } });
    expect(row.status).toBe('PENDING');
  });

  it('nimmt Entwurf und Final der BWA-Planung an und weist andere ab', async () => {
    for (const status of ['FINAL', 'DRAFT']) {
      await owner.bwaPlan.update({ where: { id: planId }, data: { status } });
    }
    for (const status of ['ARCHIVED', 'final']) {
      await expect(
        owner.$executeRaw`UPDATE bwa_plan SET status = ${status} WHERE id = ${planId}::uuid`,
      ).rejects.toThrow(/bwa_plan_status_check/);
    }
    const row = await owner.bwaPlan.findUniqueOrThrow({ where: { id: planId } });
    expect(row.status).toBe('DRAFT');
  });
});
