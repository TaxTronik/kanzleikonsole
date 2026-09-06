// Fachkatalog: PORTAL-INBOX-SUBMISSION-001
// Fachkatalog: ACCESS-SEARCH-SCOPE-001
// Fachkatalog: ACCESS-TENANT-RLS-001
// Fachkatalog: ACCESS-STAFF-PERMISSION-001
// Fachkatalog: ACCESS-NOTIFICATION-RECIPIENT-001
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import { createVerifiedLegalEntityGwgFixture } from './gwg-test-fixture';

const hasDatabase = Boolean(process.env['DATABASE_URL'] && process.env['DATABASE_APP_URL']);
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});
const app = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_APP_URL'])),
});

async function asActor<T>(
  tenantId: string,
  actorId: string | null,
  actorType: 'STAFF' | 'CLIENT_CONTACT' | 'SYSTEM',
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return app.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT set_config('app.current_tenant_id', ${tenantId}, true),
             set_config('app.current_actor_id', ${actorId}, true),
             set_config('app.current_actor_type', ${actorType}, true)
    `;
    return fn(tx);
  });
}

type ManifestItem = {
  position: number;
  sha256: Buffer;
  sizeBytes: bigint;
  mimeType: string;
  originalName: string;
};

function manifestSha256(inputs: ManifestItem[]) {
  const canonical = [...inputs]
    .sort((left, right) => left.position - right.position)
    .map((input) =>
      [
        input.position.toString(),
        input.sha256.toString('hex'),
        input.sizeBytes.toString(),
        Buffer.from(input.mimeType, 'utf8').toString('base64'),
        Buffer.from(input.originalName, 'utf8').toString('base64'),
      ].join(':'),
    )
    .join('\n');
  return createHash('sha256').update(canonical, 'utf8').digest();
}

describeWithDatabase('portal inbox staging, RLS and notification scope', () => {
  let tenantId: string;
  let otherTenantId: string;
  let clientId: string;
  let otherClientId: string;
  let staffId: string;
  let deniedStaffId: string;
  let contactId: string;
  let peerContactId: string;
  let foreignContactId: string;
  let batchId: string;
  let threadId: string;
  let messageId: string;
  let attachmentId: string;
  let rejectedAttachmentId: string;
  let acceptedDocumentId: string | undefined;
  const cleanupDocumentIds = new Set<string>();

  const originalName = 'beleg.pdf';
  const mimeType = 'application/pdf';
  const sha256 = Buffer.alloc(32, 0x51);
  const sizeBytes = 1234n;
  const rejectedOriginalName = 'nicht-erforderlich.pdf';
  const rejectedSha256 = Buffer.alloc(32, 0x61);
  const rejectedSizeBytes = 4321n;

  beforeAll(async () => {
    const seed = `${Date.now()}-${Math.random()}`;
    tenantId = (
      await owner.tenant.create({ data: { slug: `portal-inbox-${seed}`, name: 'Portal Inbox' } })
    ).id;
    otherTenantId = (
      await owner.tenant.create({
        data: { slug: `portal-inbox-other-${seed}`, name: 'Portal Inbox Other' },
      })
    ).id;

    const staff = await owner.staffUser.create({
      data: {
        tenantId,
        email: `inbox-staff-${seed}@example.test`,
        fullName: 'Inbox Staff',
        passwordHash: 'synthetic',
        roles: { create: { role: 'EMPLOYEE' } },
      },
    });
    staffId = staff.id;
    deniedStaffId = (
      await owner.staffUser.create({
        data: {
          tenantId,
          email: `inbox-denied-${seed}@example.test`,
          fullName: 'Inbox Denied',
          passwordHash: 'synthetic',
          roles: { create: { role: 'EMPLOYEE' } },
        },
      })
    ).id;
    await owner.staffPermission.create({
      data: { staffUserId: staffId, permission: 'PORTAL_INBOX_MANAGE', grantedBy: staffId },
    });

    clientId = (
      await owner.client.create({
        data: { tenantId, kind: 'JURPERS', name: 'Inbox-Mandant', allowActive: false },
      })
    ).id;
    otherClientId = (
      await owner.client.create({
        data: { tenantId, kind: 'JURPERS', name: 'Fremder Inbox-Mandant', allowActive: false },
      })
    ).id;
    await createVerifiedLegalEntityGwgFixture(owner, {
      tenantId,
      clientId,
      verifiedBy: staffId,
      registerNumber: `HRB-INBOX-${seed}`,
    });
    await createVerifiedLegalEntityGwgFixture(owner, {
      tenantId,
      clientId: otherClientId,
      verifiedBy: staffId,
      registerNumber: `HRB-INBOX-OTHER-${seed}`,
    });
    await owner.client.updateMany({
      where: { id: { in: [clientId, otherClientId] } },
      data: { allowActive: true },
    });

    contactId = (
      await owner.clientContact.create({
        data: {
          tenantId,
          clientId,
          email: `inbox-contact-${seed}@example.test`,
          fullName: 'Inbox Contact',
        },
      })
    ).id;
    peerContactId = (
      await owner.clientContact.create({
        data: {
          tenantId,
          clientId,
          email: `inbox-peer-${seed}@example.test`,
          fullName: 'Inbox Peer',
        },
      })
    ).id;
    foreignContactId = (
      await owner.clientContact.create({
        data: {
          tenantId,
          clientId: otherClientId,
          email: `inbox-foreign-${seed}@example.test`,
          fullName: 'Inbox Foreign',
        },
      })
    ).id;
    await owner.tenantSetting.upsert({
      where: { tenantId_key: { tenantId, key: 'portal.features' } },
      create: { tenantId, key: 'portal.features', value: { clientInbox: true } },
      update: { value: { clientInbox: true } },
    });

    const draft = await asActor(tenantId, contactId, 'CLIENT_CONTACT', async (tx) => {
      const batch = await tx.portalInboxUploadBatch.create({
        data: {
          tenantId,
          clientId,
          createdByContactId: contactId,
          purpose: 'NEW_THREAD',
        },
      });
      const attachment = await tx.portalInboxAttachment.create({
        data: {
          tenantId,
          clientId,
          batchId: batch.id,
          originalName,
          mimeType,
          storageBucket: 'portal-inbox-staging',
          storageKey: `tenants/${tenantId}/portal-inbox/${batch.id}/0`,
          sha256,
          sizeBytes,
          position: 0,
        },
      });
      await tx.portalInboxAttachment.update({
        where: { id: attachment.id },
        data: {
          storageVersionId: `staging-${attachment.id}`,
          scanStatus: 'CLEAN',
        },
      });
      const rejectedAttachment = await tx.portalInboxAttachment.create({
        data: {
          tenantId,
          clientId,
          batchId: batch.id,
          originalName: rejectedOriginalName,
          mimeType,
          storageBucket: 'portal-inbox-staging',
          storageKey: `tenants/${tenantId}/portal-inbox/${batch.id}/1`,
          sha256: rejectedSha256,
          sizeBytes: rejectedSizeBytes,
          position: 1,
        },
      });
      await tx.portalInboxAttachment.update({
        where: { id: rejectedAttachment.id },
        data: {
          storageVersionId: `staging-${rejectedAttachment.id}`,
          scanStatus: 'CLEAN',
        },
      });
      return {
        batchId: batch.id,
        attachmentId: attachment.id,
        rejectedAttachmentId: rejectedAttachment.id,
      };
    });
    batchId = draft.batchId;
    attachmentId = draft.attachmentId;
    rejectedAttachmentId = draft.rejectedAttachmentId;
  });

  async function createPendingAcceptanceFixture(
    input: {
      immutable?: boolean;
      hashByte?: number;
    } = {},
  ) {
    const suffix = randomUUID();
    const fixtureSha256 = Buffer.alloc(32, input.hashByte ?? 0x71);
    const fixtureSizeBytes = 2048n;
    const fixtureOriginalName = `resume-${suffix}.pdf`;
    const fixture = await asActor(tenantId, contactId, 'CLIENT_CONTACT', async (tx) => {
      const batch = await tx.portalInboxUploadBatch.create({
        data: {
          tenantId,
          clientId,
          createdByContactId: contactId,
          purpose: 'REPLY',
          targetThreadId: threadId,
        },
      });
      const attachment = await tx.portalInboxAttachment.create({
        data: {
          tenantId,
          clientId,
          batchId: batch.id,
          originalName: fixtureOriginalName,
          mimeType,
          storageBucket: 'portal-inbox-staging',
          storageKey: `tenants/${tenantId}/portal-inbox/${batch.id}/0`,
          sha256: fixtureSha256,
          sizeBytes: fixtureSizeBytes,
          position: 0,
        },
      });
      await tx.portalInboxAttachment.update({
        where: { id: attachment.id },
        data: {
          storageVersionId: `staging-${attachment.id}`,
          scanStatus: 'CLEAN',
        },
      });
      const message = await tx.portalInboxMessage.create({
        data: {
          tenantId,
          clientId,
          threadId,
          authorType: 'CLIENT_CONTACT',
          authorId: contactId,
          body: `Resume-Fixture ${suffix}`,
          clientMutationId: randomUUID(),
        },
      });
      await tx.portalInboxAttachment.update({
        where: { id: attachment.id },
        data: { messageId: message.id },
      });
      await tx.portalInboxUploadBatch.update({
        where: { id: batch.id },
        data: {
          status: 'CONSUMED',
          consumedAt: new Date(),
          manifestSha256: manifestSha256([
            {
              position: 0,
              sha256: fixtureSha256,
              sizeBytes: fixtureSizeBytes,
              mimeType,
              originalName: fixtureOriginalName,
            },
          ]),
        },
      });
      return { attachmentId: attachment.id, messageId: message.id };
    });

    const immutable = input.immutable === true;
    const document = await owner.document.create({
      data: {
        tenantId,
        clientId,
        title: fixtureOriginalName,
        classification: immutable ? 'GOBD_CONTRACT' : 'GENERAL',
        mimeType,
        retentionUntil: immutable ? new Date('2036-12-31T23:59:59.000Z') : null,
        versions: {
          create: {
            versionNo: 1,
            storageBucket: immutable ? 'gobd' : 'general',
            storageKey: `tenants/${tenantId}/${immutable ? 'gobd' : 'none'}/${suffix}`,
            storageVersionId: null,
            sha256: fixtureSha256,
            sizeBytes: fixtureSizeBytes,
            immutable,
            scanStatus: 'PENDING',
            scanCompletedAt: null,
            createdById: staffId,
          },
        },
      },
      include: { versions: true },
    });
    cleanupDocumentIds.add(document.id);
    await asActor(tenantId, staffId, 'STAFF', (tx) =>
      tx.portalInboxAttachment.update({
        where: { id: fixture.attachmentId },
        data: { acceptedDocumentId: document.id },
      }),
    );
    return {
      ...fixture,
      documentId: document.id,
      versionId: document.versions[0]!.id,
      storageBucket: document.versions[0]!.storageBucket,
      storageKey: document.versions[0]!.storageKey,
      sha256: fixtureSha256,
    };
  }

  afterAll(async () => {
    if (tenantId) {
      await owner.notification.deleteMany({ where: { tenantId } });
      await owner.portalInboxRead.deleteMany({ where: { tenantId } });
      await owner.portalInboxAttachment.deleteMany({ where: { tenantId } });
      await owner.portalInboxUploadBatch.deleteMany({ where: { tenantId } });
      await owner.portalInboxMessage.deleteMany({ where: { tenantId } });
      await owner.portalInboxThread.deleteMany({ where: { tenantId } });
      if (acceptedDocumentId) cleanupDocumentIds.add(acceptedDocumentId);
      if (cleanupDocumentIds.size > 0) {
        const ids = [...cleanupDocumentIds];
        await owner.documentVersion.deleteMany({ where: { documentId: { in: ids } } });
        await owner.document.deleteMany({ where: { id: { in: ids } } });
      }
      await owner.storageOrphan.deleteMany({ where: { tenantId } });
      await owner.tenant.delete({ where: { id: tenantId } });
    }
    if (otherTenantId) await owner.tenant.delete({ where: { id: otherTenantId } });
    await Promise.all([owner.$disconnect(), app.$disconnect()]);
  });

  it('hält OPEN-Batch und Staging-Anhang kontaktprivat', async () => {
    expect(
      await asActor(tenantId, contactId, 'CLIENT_CONTACT', (tx) =>
        tx.portalInboxUploadBatch.count({ where: { id: batchId } }),
      ),
    ).toBe(1);
    expect(
      await asActor(tenantId, peerContactId, 'CLIENT_CONTACT', (tx) =>
        tx.portalInboxUploadBatch.count({ where: { id: batchId } }),
      ),
    ).toBe(0);
    expect(
      await asActor(tenantId, peerContactId, 'CLIENT_CONTACT', (tx) =>
        tx.portalInboxAttachment.count({ where: { id: attachmentId } }),
      ),
    ).toBe(0);
  });

  it('finalisiert nur ein sauberes, exakt hashgebundenes Manifest', async () => {
    const result = await asActor(tenantId, contactId, 'CLIENT_CONTACT', async (tx) => {
      const thread = await tx.portalInboxThread.create({
        data: {
          tenantId,
          clientId,
          createdByContactId: contactId,
          subject: 'Unterlagen zur Prüfung',
          topic: 'DOCUMENTS',
        },
      });
      const message = await tx.portalInboxMessage.create({
        data: {
          tenantId,
          clientId,
          threadId: thread.id,
          authorType: 'CLIENT_CONTACT',
          authorId: contactId,
          body: 'Bitte prüfen Sie die beigefügte Unterlage.',
          clientMutationId: randomUUID(),
        },
      });
      await tx.portalInboxAttachment.update({
        where: { id: attachmentId },
        data: { messageId: message.id },
      });
      await tx.portalInboxAttachment.update({
        where: { id: rejectedAttachmentId },
        data: { messageId: message.id },
      });
      await tx.portalInboxUploadBatch.update({
        where: { id: batchId },
        data: {
          status: 'CONSUMED',
          consumedAt: new Date(),
          manifestSha256: manifestSha256([
            { position: 0, sha256, sizeBytes, mimeType, originalName },
            {
              position: 1,
              sha256: rejectedSha256,
              sizeBytes: rejectedSizeBytes,
              mimeType,
              originalName: rejectedOriginalName,
            },
          ]),
        },
      });
      return { threadId: thread.id, messageId: message.id };
    });
    threadId = result.threadId;
    messageId = result.messageId;

    await expect(
      asActor(tenantId, contactId, 'CLIENT_CONTACT', (tx) =>
        tx.portalInboxAttachment.update({
          where: { id: attachmentId },
          data: { sha256: Buffer.alloc(32, 0x52) },
        }),
      ),
    ).rejects.toThrow();
  });

  it('PORTAL-INBOX-SUBMISSION-001 lehnt eine echte PENDING-Reservierung atomar ab', async () => {
    const fixture = await createPendingAcceptanceFixture({ immutable: true, hashByte: 0x72 });

    await expect(
      asActor(tenantId, staffId, 'STAFF', async (tx) => {
        const [result] = await tx.$queryRaw<Array<{ rejected: boolean }>>`
          SELECT app.reject_pending_portal_inbox_attachment(
            ${fixture.attachmentId}::uuid,
            ${'NOT_REQUIRED'}::text
          ) AS rejected
        `;
        return result?.rejected;
      }),
    ).resolves.toBe(true);

    expect(
      await owner.portalInboxAttachment.findUniqueOrThrow({
        where: { id: fixture.attachmentId },
        select: {
          decision: true,
          acceptedDocumentId: true,
          rejectionReason: true,
          decidedByStaffId: true,
        },
      }),
    ).toEqual({
      decision: 'REJECTED',
      acceptedDocumentId: null,
      rejectionReason: 'NOT_REQUIRED',
      decidedByStaffId: staffId,
    });
    expect(await owner.document.findUnique({ where: { id: fixture.documentId } })).toBeNull();
    expect(await owner.documentVersion.findUnique({ where: { id: fixture.versionId } })).toBeNull();
    const orphan = await owner.storageOrphan.findFirstOrThrow({
      where: {
        tenantId,
        storageBucket: fixture.storageBucket,
        storageKey: fixture.storageKey,
      },
      select: {
        source: true,
        storageVersionId: true,
        sha256: true,
        immutable: true,
      },
    });
    expect(orphan).toMatchObject({
      source: 'portal-inbox-acceptance-aborted',
      storageVersionId: '',
      immutable: true,
    });
    expect(Buffer.from(orphan.sha256)).toEqual(fixture.sha256);
  });

  it('DOC-UPLOAD-JOURNAL-001 / DOC-VERSION-IMMUTABILITY-001 bleiben bei Scope-, Hash- und Versionsabweichung fail-closed', async () => {
    const hashFixture = await createPendingAcceptanceFixture({ hashByte: 0x73 });
    await owner.documentVersion.update({
      where: { id: hashFixture.versionId },
      data: { sha256: Buffer.alloc(32, 0x74) },
    });
    await expect(
      asActor(
        tenantId,
        staffId,
        'STAFF',
        (tx) =>
          tx.$queryRaw`
          SELECT app.reject_pending_portal_inbox_attachment(
            ${hashFixture.attachmentId}::uuid,
            ${'OTHER'}::text
          )
        `,
      ),
    ).rejects.toThrow();
    expect(
      await owner.portalInboxAttachment.findUniqueOrThrow({
        where: { id: hashFixture.attachmentId },
        select: { decision: true, acceptedDocumentId: true },
      }),
    ).toEqual({
      decision: 'PENDING_REVIEW',
      acceptedDocumentId: hashFixture.documentId,
    });
    expect(
      await owner.storageOrphan.count({
        where: { storageBucket: hashFixture.storageBucket, storageKey: hashFixture.storageKey },
      }),
    ).toBe(0);
    await owner.documentVersion.update({
      where: { id: hashFixture.versionId },
      data: { sha256: hashFixture.sha256 },
    });
    await asActor(
      tenantId,
      staffId,
      'STAFF',
      (tx) =>
        tx.$queryRaw`
        SELECT app.reject_pending_portal_inbox_attachment(
          ${hashFixture.attachmentId}::uuid,
          ${'OTHER'}::text
        )
      `,
    );

    const versionFixture = await createPendingAcceptanceFixture({ hashByte: 0x75 });
    const extraVersion = await owner.documentVersion.create({
      data: {
        documentId: versionFixture.documentId,
        versionNo: 2,
        storageBucket: versionFixture.storageBucket,
        storageKey: `${versionFixture.storageKey}-second`,
        storageVersionId: null,
        sha256: versionFixture.sha256,
        sizeBytes: 2048n,
        immutable: false,
        scanStatus: 'PENDING',
        scanCompletedAt: null,
        createdById: staffId,
      },
    });
    await expect(
      asActor(
        tenantId,
        staffId,
        'STAFF',
        (tx) =>
          tx.$queryRaw`
          SELECT app.reject_pending_portal_inbox_attachment(
            ${versionFixture.attachmentId}::uuid,
            ${'DUPLICATE'}::text
          )
        `,
      ),
    ).rejects.toThrow();
    expect(
      await owner.documentVersion.count({ where: { documentId: versionFixture.documentId } }),
    ).toBe(2);
    await owner.documentVersion.delete({ where: { id: extraVersion.id } });
    await asActor(
      tenantId,
      staffId,
      'STAFF',
      (tx) =>
        tx.$queryRaw`
        SELECT app.reject_pending_portal_inbox_attachment(
          ${versionFixture.attachmentId}::uuid,
          ${'DUPLICATE'}::text
        )
      `,
    );

    const scopeFixture = await createPendingAcceptanceFixture({ hashByte: 0x76 });
    await expect(
      asActor(
        otherTenantId,
        staffId,
        'STAFF',
        (tx) =>
          tx.$queryRaw`
          SELECT app.reject_pending_portal_inbox_attachment(
            ${scopeFixture.attachmentId}::uuid,
            ${'UNSUPPORTED'}::text
          )
        `,
      ),
    ).rejects.toThrow();
    expect(
      await owner.portalInboxAttachment.findUniqueOrThrow({
        where: { id: scopeFixture.attachmentId },
        select: { decision: true, acceptedDocumentId: true },
      }),
    ).toEqual({
      decision: 'PENDING_REVIEW',
      acceptedDocumentId: scopeFixture.documentId,
    });
    await asActor(
      tenantId,
      staffId,
      'STAFF',
      (tx) =>
        tx.$queryRaw`
        SELECT app.reject_pending_portal_inbox_attachment(
          ${scopeFixture.attachmentId}::uuid,
          ${'UNSUPPORTED'}::text
        )
      `,
    );
  });

  it('PORTAL-INBOX-SUBMISSION-001 serialisiert Commit gegen parallele Ablehnung', async () => {
    const fixture = await createPendingAcceptanceFixture({ hashByte: 0x77 });
    let releaseCommit!: () => void;
    let markLocked!: () => void;
    const commitRelease = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const rowLocked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });

    const commit = app.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT set_config('app.current_tenant_id', ${tenantId}, true),
               set_config('app.current_actor_id', ${staffId}, true),
               set_config('app.current_actor_type', ${'STAFF'}, true)
      `;
      await tx.$queryRaw`
        SELECT "id"
          FROM "portal_inbox_attachment"
         WHERE "id" = ${fixture.attachmentId}::uuid
           AND "tenant_id" = ${tenantId}::uuid
           AND "client_id" = ${clientId}::uuid
         FOR UPDATE
      `;
      markLocked();
      await commitRelease;
      await tx.documentVersion.update({
        where: { id: fixture.versionId },
        data: {
          storageVersionId: 'committed-version',
          scanStatus: 'CLEAN',
          scanCompletedAt: new Date(),
        },
      });
      const decidedAt = new Date();
      await tx.portalInboxAttachment.update({
        where: { id: fixture.attachmentId },
        data: {
          decision: 'ACCEPTED',
          decidedByStaffId: staffId,
          decidedAt,
        },
      });
      await tx.document.update({
        where: { id: fixture.documentId },
        data: { sharedWithClientAt: decidedAt, sharedByStaff: staffId },
      });
    });
    await rowLocked;

    const rejectAttempt = asActor(
      tenantId,
      staffId,
      'STAFF',
      (tx) =>
        tx.$queryRaw`
        SELECT app.reject_pending_portal_inbox_attachment(
          ${fixture.attachmentId}::uuid,
          ${'OTHER'}::text
        )
      `,
    ).then(
      () => ({ status: 'fulfilled' as const }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    expect(
      await Promise.race([
        rejectAttempt.then((result) => result.status),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 25)),
      ]),
    ).toBe('blocked');

    releaseCommit();
    await commit;
    const rejected = await rejectAttempt;
    expect(rejected.status).toBe('rejected');
    expect(
      await owner.portalInboxAttachment.findUniqueOrThrow({
        where: { id: fixture.attachmentId },
        select: { decision: true, acceptedDocumentId: true },
      }),
    ).toEqual({ decision: 'ACCEPTED', acceptedDocumentId: fixture.documentId });
    expect(
      await owner.storageOrphan.count({
        where: { storageBucket: fixture.storageBucket, storageKey: fixture.storageKey },
      }),
    ).toBe(0);
  });

  it('zeigt abgesendete Threads und saubere Anhänge mandantenweit, nie mandantenfremd', async () => {
    for (const actorId of [contactId, peerContactId]) {
      expect(
        await asActor(tenantId, actorId, 'CLIENT_CONTACT', (tx) =>
          tx.portalInboxThread.count({ where: { id: threadId } }),
        ),
      ).toBe(1);
      expect(
        await asActor(tenantId, actorId, 'CLIENT_CONTACT', (tx) =>
          tx.portalInboxMessage.count({ where: { id: messageId } }),
        ),
      ).toBe(1);
      expect(
        await asActor(tenantId, actorId, 'CLIENT_CONTACT', (tx) =>
          tx.portalInboxAttachment.count({ where: { id: attachmentId } }),
        ),
      ).toBe(1);
    }
    expect(
      await asActor(tenantId, foreignContactId, 'CLIENT_CONTACT', (tx) =>
        tx.portalInboxThread.count({ where: { id: threadId } }),
      ),
    ).toBe(0);
    expect(
      await asActor(otherTenantId, contactId, 'CLIENT_CONTACT', (tx) =>
        tx.portalInboxThread.count({ where: { id: threadId } }),
      ),
    ).toBe(0);
  });

  it('verlangt Staff-Einzelrecht plus aktuellen Mandantenzugriff', async () => {
    expect(
      await asActor(tenantId, staffId, 'STAFF', (tx) =>
        tx.portalInboxThread.count({ where: { id: threadId } }),
      ),
    ).toBe(1);
    expect(
      await asActor(tenantId, deniedStaffId, 'STAFF', (tx) =>
        tx.portalInboxThread.count({ where: { id: threadId } }),
      ),
    ).toBe(0);

    await owner.staffPermission.delete({
      where: {
        staffUserId_permission: { staffUserId: staffId, permission: 'PORTAL_INBOX_MANAGE' },
      },
    });
    expect(
      await asActor(tenantId, staffId, 'STAFF', (tx) =>
        tx.portalInboxThread.count({ where: { id: threadId } }),
      ),
    ).toBe(0);
    await owner.staffPermission.create({
      data: { staffUserId: staffId, permission: 'PORTAL_INBOX_MANAGE', grantedBy: staffId },
    });
  });

  it('routet Portal-Threads nur bei genau einem berechtigten Hauptbearbeiter', async () => {
    const responsibility = await owner.clientResponsibility.create({
      data: {
        tenantId,
        clientId,
        staffId,
        role: 'HAUPTBEARBEITER',
      },
    });
    const uniquelyAssigned = await asActor(tenantId, contactId, 'CLIENT_CONTACT', (tx) =>
      tx.portalInboxThread.create({
        data: {
          tenantId,
          clientId,
          createdByContactId: contactId,
          subject: 'Eindeutiges Routing',
          // Ein vom Portal eingeschleuster Wert wird DB-seitig verworfen.
          assignedStaffId: deniedStaffId,
        },
        select: { id: true, assignedStaffId: true },
      }),
    );
    expect(uniquelyAssigned.assignedStaffId).toBe(staffId);

    await owner.staffPermission.create({
      data: {
        staffUserId: deniedStaffId,
        permission: 'PORTAL_INBOX_MANAGE',
        grantedBy: staffId,
      },
    });
    const secondResponsibility = await owner.clientResponsibility.create({
      data: {
        tenantId,
        clientId,
        staffId: deniedStaffId,
        role: 'HAUPTBEARBEITER',
      },
    });

    // Entzug zwischen zwei Nachrichten darf den Verlauf weder unsichtbar
    // machen noch den Portal-Write blockieren. Der Trigger routet auf den nun
    // einzig berechtigten Hauptbearbeiter um.
    await owner.staffPermission.delete({
      where: {
        staffUserId_permission: {
          staffUserId: staffId,
          permission: 'PORTAL_INBOX_MANAGE',
        },
      },
    });
    await asActor(tenantId, contactId, 'CLIENT_CONTACT', (tx) =>
      tx.portalInboxMessage.create({
        data: {
          tenantId,
          clientId,
          threadId: uniquelyAssigned.id,
          authorType: 'CLIENT_CONTACT',
          authorId: contactId,
          body: 'Nach Bearbeiterwechsel weiterhin zustellbar',
          clientMutationId: randomUUID(),
        },
      }),
    );
    expect(
      (
        await owner.portalInboxThread.findUniqueOrThrow({
          where: { id: uniquelyAssigned.id },
          select: { assignedStaffId: true },
        })
      ).assignedStaffId,
    ).toBe(deniedStaffId);
    await owner.staffPermission.create({
      data: { staffUserId: staffId, permission: 'PORTAL_INBOX_MANAGE', grantedBy: staffId },
    });

    const teamRouted = await asActor(tenantId, contactId, 'CLIENT_CONTACT', (tx) =>
      tx.portalInboxThread.create({
        data: {
          tenantId,
          clientId,
          createdByContactId: contactId,
          subject: 'Mehrdeutiges Routing',
          assignedStaffId: staffId,
        },
        select: { id: true, assignedStaffId: true },
      }),
    );
    expect(teamRouted.assignedStaffId).toBeNull();

    await owner.clientResponsibility.deleteMany({
      where: { id: { in: [responsibility.id, secondResponsibility.id] } },
    });
    await owner.staffPermission.delete({
      where: {
        staffUserId_permission: {
          staffUserId: deniedStaffId,
          permission: 'PORTAL_INBOX_MANAGE',
        },
      },
    });
  });

  it('projiziert Ablehnungs-Codes ohne Storagefelder und sperrt den Bytepfad', async () => {
    await asActor(tenantId, staffId, 'STAFF', (tx) =>
      tx.portalInboxAttachment.update({
        where: { id: rejectedAttachmentId },
        data: {
          decision: 'REJECTED',
          decidedByStaffId: staffId,
          decidedAt: new Date(),
          rejectionReason: 'NOT_REQUIRED',
        },
      }),
    );

    expect(
      await asActor(tenantId, contactId, 'CLIENT_CONTACT', (tx) =>
        tx.portalInboxAttachment.count({ where: { id: rejectedAttachmentId } }),
      ),
    ).toBe(0);
    const receipts = await asActor(
      tenantId,
      peerContactId,
      'CLIENT_CONTACT',
      (tx) =>
        tx.$queryRaw<
          Array<{
            attachment_id: string;
            decision: string;
            rejection_reason: string | null;
            download_allowed: boolean;
          }>
        >`SELECT attachment_id, decision::text, rejection_reason, download_allowed
          FROM app.portal_inbox_attachment_receipts(${tenantId}::uuid, ${threadId}::uuid)`,
    );
    expect(receipts).toContainEqual({
      attachment_id: rejectedAttachmentId,
      decision: 'REJECTED',
      rejection_reason: 'NOT_REQUIRED',
      download_allowed: false,
    });
    expect(Object.keys(receipts[0] ?? {})).not.toContain('storage_key');
  });

  it('bindet Mutation-IDs autorweit und threadübergreifend', async () => {
    const mutationId = randomUUID();
    await asActor(tenantId, contactId, 'CLIENT_CONTACT', (tx) =>
      tx.portalInboxMessage.create({
        data: {
          tenantId,
          clientId,
          threadId,
          authorType: 'CLIENT_CONTACT',
          authorId: contactId,
          body: 'Erste idempotente Nachricht',
          clientMutationId: mutationId,
        },
      }),
    );
    await expect(
      asActor(tenantId, contactId, 'CLIENT_CONTACT', async (tx) => {
        const secondThread = await tx.portalInboxThread.create({
          data: {
            tenantId,
            clientId,
            createdByContactId: contactId,
            subject: 'Darf nicht committed werden',
          },
        });
        await tx.portalInboxMessage.create({
          data: {
            tenantId,
            clientId,
            threadId: secondThread.id,
            authorType: 'CLIENT_CONTACT',
            authorId: contactId,
            body: 'Doppelte Mutation',
            clientMutationId: mutationId,
          },
        });
      }),
    ).rejects.toThrow();
  });

  it('erzwingt die autorweite Mutation-ID auch bei paralleler Thread-Anlage', async () => {
    const mutationId = randomUUID();
    const subject = `Paralleler Retry ${mutationId}`;
    const createThreadAndMessage = () =>
      asActor(tenantId, contactId, 'CLIENT_CONTACT', async (tx) => {
        const thread = await tx.portalInboxThread.create({
          data: {
            tenantId,
            clientId,
            createdByContactId: contactId,
            subject,
          },
        });
        return tx.portalInboxMessage.create({
          data: {
            tenantId,
            clientId,
            threadId: thread.id,
            authorType: 'CLIENT_CONTACT',
            authorId: contactId,
            body: 'Parallel identischer Submit',
            clientMutationId: mutationId,
          },
        });
      });

    const attempts = await Promise.allSettled([createThreadAndMessage(), createThreadAndMessage()]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    expect(
      await owner.portalInboxMessage.count({
        where: {
          tenantId,
          clientId,
          authorType: 'CLIENT_CONTACT',
          authorId: contactId,
          clientMutationId: mutationId,
        },
      }),
    ).toBe(1);
    expect(await owner.portalInboxThread.count({ where: { tenantId, clientId, subject } })).toBe(1);
  });

  it('archiviert erst nach Staff-Entscheidung und bindet exakt denselben Hash', async () => {
    const document = await owner.document.create({
      data: {
        tenantId,
        clientId,
        title: originalName,
        classification: 'GENERAL',
        mimeType,
        versions: {
          create: {
            versionNo: 1,
            storageBucket: 'general-archive',
            storageKey: `tenants/${tenantId}/none/accepted-${attachmentId}`,
            storageVersionId: null,
            sha256,
            sizeBytes,
            scanStatus: 'PENDING',
            scanCompletedAt: null,
            createdById: staffId,
          },
        },
      },
    });
    acceptedDocumentId = document.id;

    await asActor(tenantId, staffId, 'STAFF', (tx) =>
      tx.portalInboxAttachment.update({
        where: { id: attachmentId },
        data: { acceptedDocumentId: document.id },
      }),
    );
    expect(
      await owner.portalInboxAttachment.findUnique({
        where: { id: attachmentId },
        select: { decision: true, acceptedDocumentId: true },
      }),
    ).toEqual({ decision: 'PENDING_REVIEW', acceptedDocumentId: document.id });

    await owner.documentVersion.updateMany({
      where: { documentId: document.id },
      data: {
        storageVersionId: `accepted-${attachmentId}`,
        scanStatus: 'CLEAN',
        scanCompletedAt: new Date(),
      },
    });

    await asActor(tenantId, staffId, 'STAFF', (tx) =>
      tx.portalInboxAttachment.update({
        where: { id: attachmentId },
        data: {
          decision: 'ACCEPTED',
          acceptedDocumentId: document.id,
          decidedByStaffId: staffId,
          decidedAt: new Date(),
        },
      }),
    );
    expect(
      await owner.portalInboxAttachment.findUnique({
        where: { id: attachmentId },
        select: { decision: true, acceptedDocumentId: true },
      }),
    ).toEqual({ decision: 'ACCEPTED', acceptedDocumentId: document.id });
    expect(
      (await owner.document.findUniqueOrThrow({ where: { id: document.id } })).sharedWithClientAt,
    ).toBeNull();
  });

  it('erzeugt nur generische write-only Hinweise und entzieht sie mit dem Recht', async () => {
    await asActor(tenantId, contactId, 'CLIENT_CONTACT', async (tx) => {
      const result = await tx.$queryRaw<Array<{ notified: boolean }>>`
        SELECT app.notify_portal_inbox_activity(
          ${tenantId}::uuid,
          ${threadId}::uuid,
          ${staffId}::uuid
        ) AS notified
      `;
      expect(result[0]?.notified).toBe(true);
    });
    const notification = await owner.notification.findFirstOrThrow({
      where: { tenantId, kind: 'PORTAL_INBOX_ACTIVITY', resourceId: threadId },
    });
    expect(notification).toMatchObject({
      clientId,
      staffId,
      title: 'Neue Mandantenpost',
      body: null,
      resourceType: 'portal_inbox_thread',
    });
    expect(
      await asActor(tenantId, staffId, 'STAFF', (tx) =>
        tx.notification.count({ where: { id: notification.id } }),
      ),
    ).toBe(1);

    await owner.staffPermission.delete({
      where: {
        staffUserId_permission: { staffUserId: staffId, permission: 'PORTAL_INBOX_MANAGE' },
      },
    });
    expect(
      await asActor(tenantId, staffId, 'STAFF', (tx) =>
        tx.notification.count({ where: { id: notification.id } }),
      ),
    ).toBe(0);
  });
});
