import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  prepare: vi.fn(),
  recover: vi.fn(),
  commit: vi.fn(),
  withTenant: vi.fn(),
  assertIdentity: vi.fn(),
  compensate: vi.fn(),
  queryRaw: vi.fn(),
  batchFindFirst: vi.fn(),
  attachmentCreate: vi.fn(),
  attachmentFindFirst: vi.fn(),
  attachmentUpdateMany: vi.fn(),
}));

vi.mock('@taxtronik/storage', () => ({
  prepareBytesCommitWithTier: h.prepare,
  recoverPreparedBytesCommit: h.recover,
  commitPreparedBytes: h.commit,
}));
vi.mock('@taxtronik/db', () => ({ withTenantContext: h.withTenant }));
vi.mock('@/server/db/prisma-bytes', () => ({ prismaBytes: (value: Buffer) => value }));
vi.mock('@/server/documents/storage-compensation', () => ({
  compensateStorageCommit: h.compensate,
}));
vi.mock('../access', () => ({ assertActivePortalInboxIdentityTx: h.assertIdentity }));

import { InboxUploadError, InboxUploadPolicyError, stageInboxAttachment } from '../staging-upload';

const prepared = {
  tier: 'NONE' as const,
  tenantId: 'tenant-1',
  targetBucket: 'staging',
  targetKey: 'tenants/tenant-1/inbox/key-1',
  storageVersionId: null,
  sha256: Buffer.from('abcd', 'hex'),
  sizeBytes: 4n,
  immutable: false,
  retentionUntil: null,
  detectedMime: 'application/pdf',
};
const actor = {
  context: { tenantId: 'tenant-1', actorId: 'contact-1', actorType: 'CLIENT_CONTACT' as const },
  tenantId: 'tenant-1',
  clientId: 'client-1',
  contactId: 'contact-1',
};

function txFixture() {
  return {
    $queryRaw: h.queryRaw,
    portalInboxUploadBatch: { findFirst: h.batchFindFirst },
    portalInboxAttachment: {
      create: h.attachmentCreate,
      findFirst: h.attachmentFindFirst,
      updateMany: h.attachmentUpdateMany,
    },
  };
}

describe('DOC-UPLOAD-JOURNAL-001 / PORTAL-INBOX-SUBMISSION-001 staging', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    const tx = txFixture();
    h.withTenant.mockImplementation(async (_context, callback) => callback(tx));
    h.prepare.mockResolvedValue(prepared);
    h.recover.mockResolvedValue(null);
    h.commit.mockResolvedValue({ ...prepared, storageVersionId: 'version-1' });
    h.queryRaw.mockResolvedValue([{ id: 'batch-1' }]);
    h.batchFindFirst.mockResolvedValue({ id: 'batch-1', attachments: [] });
    h.attachmentCreate.mockResolvedValue({ id: 'attachment-1' });
    h.attachmentUpdateMany.mockResolvedValue({ count: 1 });
  });

  it('persistiert den PENDING-Intent zwingend vor dem Object-Write', async () => {
    await expect(
      stageInboxAttachment({
        actor,
        batchId: 'batch-1',
        fileData: Buffer.from('%PDF-1.7'),
        originalName: '../beleg.pdf',
      }),
    ).resolves.toMatchObject({ attachmentId: 'attachment-1', resumed: false });

    expect(h.attachmentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          scanStatus: 'PENDING',
          decision: 'PENDING_REVIEW',
          originalName: '.._beleg.pdf',
        }),
      }),
    );
    expect(h.attachmentCreate.mock.invocationCallOrder[0]).toBeLessThan(
      h.commit.mock.invocationCallOrder[0]!,
    );
    expect(h.attachmentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { storageVersionId: 'version-1', scanStatus: 'CLEAN' } }),
    );
  });

  it('nimmt einen nach Commit abgebrochenen Intent am selben Key wieder auf', async () => {
    h.attachmentFindFirst.mockResolvedValue({
      id: 'attachment-1',
      tenantId: 'tenant-1',
      originalName: 'beleg.pdf',
      mimeType: 'application/pdf',
      storageBucket: prepared.targetBucket,
      storageKey: prepared.targetKey,
      storageVersionId: null,
      sha256: prepared.sha256,
      sizeBytes: prepared.sizeBytes,
      scanStatus: 'PENDING',
      decision: 'PENDING_REVIEW',
    });
    h.recover.mockResolvedValue({ ...prepared, storageVersionId: 'existing-version' });

    await expect(
      stageInboxAttachment({
        actor,
        batchId: 'batch-1',
        fileData: Buffer.from('%PDF-1.7'),
        originalName: 'wird-nicht-ueberschrieben.pdf',
        resumeAttachmentId: 'attachment-1',
      }),
    ).resolves.toMatchObject({
      attachmentId: 'attachment-1',
      originalName: 'beleg.pdf',
      resumed: true,
    });
    expect(h.attachmentCreate).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.attachmentUpdateMany).toHaveBeenCalledOnce();
  });

  it('blockiert verschlüsselte PDFs und nicht erlaubte Magic-Byte-Typen neutral vor dem Journal', async () => {
    await expect(
      stageInboxAttachment({
        actor,
        batchId: 'batch-1',
        fileData: Buffer.from('%PDF-1.7\n1 0 obj << /Encrypt 2 0 R >>'),
        originalName: 'protected.pdf',
      }),
    ).rejects.toMatchObject({
      name: 'InboxUploadError',
      phase: 'prepare',
      cause: expect.objectContaining({ code: 'ENCRYPTED_PDF' }),
    } satisfies Partial<InboxUploadError>);

    h.prepare.mockResolvedValueOnce({ ...prepared, detectedMime: 'application/zip' });
    await expect(
      stageInboxAttachment({
        actor,
        batchId: 'batch-1',
        fileData: Buffer.from('PK\u0003\u0004'),
        originalName: 'archive.pdf',
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof InboxUploadError &&
        error.cause instanceof InboxUploadPolicyError &&
        error.cause.code === 'TYPE_BLOCKED',
    );
    expect(h.attachmentCreate).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
  });
});
