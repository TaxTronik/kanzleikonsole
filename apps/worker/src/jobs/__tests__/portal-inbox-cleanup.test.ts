import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const updateMany = vi.fn();
  const queryRaw = vi.fn();
  const deleteMany = vi.fn();
  const upsert = vi.fn();
  const tx = {
    portalInboxUploadBatch: { updateMany },
    portalInboxAttachment: { deleteMany },
    storageOrphan: { upsert },
    $queryRaw: queryRaw,
  };
  return {
    tenantFindMany: vi.fn(),
    updateMany,
    queryRaw,
    deleteMany,
    upsert,
    recover: vi.fn(),
    record: vi.fn(),
    withWorkerTenantContext: vi.fn(
      (_tenantId: string, fn: (transaction: typeof tx) => Promise<unknown>) => fn(tx),
    ),
    tx,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../prisma-owner', () => ({
  prismaOwner: { tenant: { findMany: h.tenantFindMany } },
}));
vi.mock('../../tenant-context', () => ({
  withWorkerTenantContext: h.withWorkerTenantContext,
}));
vi.mock('../../logger', () => ({ log: h.log }));
vi.mock('@taxtronik/storage', () => ({ recoverPreparedBytesCommit: h.recover }));
vi.mock('@taxtronik/evidence', () => ({
  LocalTimestampAdapter: class LocalTimestampAdapter {},
  EvidenceService: class EvidenceService {
    record(...args: unknown[]) {
      return h.record(...args);
    }
  },
}));

import { runPortalInboxCleanup } from '../portal-inbox-cleanup';

const NOW = new Date('2026-09-01T12:00:00.000Z');
const TENANT = '10000000-0000-4000-8000-000000000001';

function candidate(
  overrides: Partial<{
    id: string;
    tenantId: string;
    storageVersionId: string | null;
    scanStatus: 'PENDING' | 'CLEAN' | 'BLOCKED';
    decision: 'PENDING_REVIEW' | 'ACCEPTED' | 'REJECTED' | 'BLOCKED';
    batchStatus: 'CONSUMED' | 'DISCARDED' | 'EXPIRED';
  }> = {},
) {
  return {
    id: '20000000-0000-4000-8000-000000000001',
    tenantId: TENANT,
    storageBucket: 'staging',
    storageKey: `tenants/${TENANT}/inbox/attachment-1`,
    storageVersionId: 'v1',
    sha256: new Uint8Array(32).fill(1),
    sizeBytes: 3n,
    mimeType: 'application/pdf',
    scanStatus: 'CLEAN' as const,
    decision: 'ACCEPTED' as const,
    batchStatus: 'CONSUMED' as const,
    ...overrides,
  };
}

describe('PORTAL-INBOX-SUBMISSION-001 / DSGVO-OPERATIONAL-RETENTION-001 cleanup', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    h.tenantFindMany.mockResolvedValue([{ id: TENANT }]);
    h.updateMany.mockResolvedValue({ count: 0 });
    h.queryRaw.mockResolvedValue([]);
    h.deleteMany.mockResolvedValue({ count: 1 });
    h.upsert.mockResolvedValue({ tenantId: TENANT });
    h.recover.mockResolvedValue(null);
    h.record.mockResolvedValue({ id: 1n });
    h.withWorkerTenantContext.mockImplementation(
      (_tenantId: string, fn: (transaction: typeof h.tx) => Promise<unknown>) => fn(h.tx),
    );
  });

  it('expires stale drafts and selects cleanup work only in SYSTEM tenant context', async () => {
    h.updateMany.mockResolvedValue({ count: 2 });

    await expect(runPortalInboxCleanup(NOW)).resolves.toEqual({
      expiredBatches: 2,
      queuedObjects: 0,
      pendingWithoutObject: 0,
      removedMissingIntents: 0,
      failed: 0,
    });

    expect(h.tenantFindMany).toHaveBeenCalledWith({ select: { id: true } });
    expect(h.withWorkerTenantContext).toHaveBeenCalledTimes(1);
    expect(h.withWorkerTenantContext.mock.calls[0]![0]).toBe(TENANT);
    expect(h.updateMany).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT,
        status: 'OPEN',
        OR: [
          { expiresAt: { lte: NOW } },
          { createdAt: { lte: new Date('2026-08-31T12:00:00.000Z') } },
        ],
      },
      data: { status: 'EXPIRED' },
    });
  });

  it('excludes every durable orphan journal row before LIMIT so old rows cannot starve work', async () => {
    await runPortalInboxCleanup(NOW);

    const template = h.queryRaw.mock.calls[0]![0] as TemplateStringsArray;
    const sql = template.join('?');
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('FROM "storage_orphan" AS orphan');
    expect(sql).not.toContain('orphan."cleaned_at"');
    expect(sql).toContain('attachment."storage_version_id" IS NULL');
    expect(sql).toContain('COALESCE(');
    expect(sql).toContain('attachment."updated_at"');
    expect(sql.indexOf('NOT EXISTS')).toBeLessThan(sql.indexOf('LIMIT'));
  });

  it('selects CLEAN draft bytes only when they are old, terminal and never submitted', async () => {
    await runPortalInboxCleanup(NOW);

    const template = h.queryRaw.mock.calls[0]![0] as TemplateStringsArray;
    const sql = template.join('?');
    expect(sql).toContain('attachment."decision" = \'PENDING_REVIEW\'');
    expect(sql).toContain("attachment.\"scan_status\" IN ('PENDING', 'CLEAN')");
    expect(sql).toContain('attachment."message_id" IS NULL');
    expect(sql).toContain('attachment."created_at" <=');
    expect(sql).toContain("batch.\"status\" IN ('DISCARDED', 'EXPIRED')");
    expect(sql).not.toContain('batch."status" IN (\'CONSUMED\'');
  });

  it('journals accepted staging bytes idempotently in the matching tenant context', async () => {
    h.queryRaw.mockResolvedValue([candidate()]);

    await expect(runPortalInboxCleanup(NOW)).resolves.toMatchObject({ queuedObjects: 1 });

    expect(h.withWorkerTenantContext).toHaveBeenCalledTimes(2);
    expect(h.withWorkerTenantContext.mock.calls.map((call) => call[0])).toEqual([TENANT, TENANT]);
    expect(h.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          storageBucket_storageKey_storageVersionId: {
            storageBucket: 'staging',
            storageKey: `tenants/${TENANT}/inbox/attachment-1`,
            storageVersionId: 'v1',
          },
        },
        create: expect.objectContaining({
          tenantId: TENANT,
          source: 'portal-inbox-staging-accepted',
          failure: 'PORTAL_INBOX_STAGING_CLEANUP_DUE',
        }),
        update: {},
        select: { tenantId: true },
      }),
    );
  });

  it('removes an expired missing PENDING intent atomically with content-free evidence', async () => {
    h.queryRaw.mockResolvedValue([
      candidate({
        storageVersionId: null,
        scanStatus: 'PENDING',
        decision: 'PENDING_REVIEW',
        batchStatus: 'EXPIRED',
      }),
    ]);

    await expect(runPortalInboxCleanup(NOW)).resolves.toMatchObject({
      queuedObjects: 0,
      pendingWithoutObject: 1,
      removedMissingIntents: 1,
      failed: 0,
    });

    expect(h.recover).toHaveBeenCalledOnce();
    expect(h.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: '20000000-0000-4000-8000-000000000001',
        tenantId: TENANT,
        storageVersionId: null,
        scanStatus: 'PENDING',
        decision: 'PENDING_REVIEW',
        messageId: null,
        createdAt: { lte: new Date('2026-08-31T12:00:00.000Z') },
        batch: { status: { in: ['DISCARDED', 'EXPIRED'] } },
      }),
    });
    expect(h.record).toHaveBeenCalledWith(
      h.tx,
      expect.objectContaining({
        tenantId: TENANT,
        actorType: 'SYSTEM',
        actorId: null,
        action: 'portal_inbox.upload_intent.remove_missing',
        resourceType: 'portal_inbox_attachment',
        resourceId: '20000000-0000-4000-8000-000000000001',
        after: {
          reasonCode: 'STAGING_OBJECT_NOT_FOUND',
          batchStatus: 'EXPIRED',
          draftCutoff: '2026-08-31T12:00:00.000Z',
        },
      }),
    );
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.withWorkerTenantContext.mock.calls.map((call) => call[0])).toEqual([TENANT, TENANT]);
  });

  it('journals a recovered PENDING object and does not remove its intent as missing', async () => {
    h.queryRaw.mockResolvedValue([
      candidate({
        storageVersionId: null,
        scanStatus: 'PENDING',
        decision: 'PENDING_REVIEW',
        batchStatus: 'DISCARDED',
      }),
    ]);
    h.recover.mockResolvedValue({
      targetBucket: 'staging',
      targetKey: `tenants/${TENANT}/inbox/attachment-1`,
      storageVersionId: 'recovered-v1',
      sha256: Buffer.alloc(32, 1),
      sizeBytes: 3n,
      immutable: false,
      retentionUntil: null,
      detectedMime: 'application/pdf',
    });

    await expect(runPortalInboxCleanup(NOW)).resolves.toMatchObject({
      queuedObjects: 1,
      pendingWithoutObject: 0,
      removedMissingIntents: 0,
    });
    expect(h.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          source: 'portal-inbox-draft-expired',
          storageVersionId: 'recovered-v1',
        }),
      }),
    );
    expect(h.deleteMany).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
  });

  it('journals a CLEAN unsubmitted attachment after its draft batch expired', async () => {
    h.queryRaw.mockResolvedValue([
      candidate({
        scanStatus: 'CLEAN',
        decision: 'PENDING_REVIEW',
        batchStatus: 'EXPIRED',
      }),
    ]);

    await expect(runPortalInboxCleanup(NOW)).resolves.toMatchObject({
      queuedObjects: 1,
      pendingWithoutObject: 0,
      removedMissingIntents: 0,
    });
    expect(h.recover).not.toHaveBeenCalled();
    expect(h.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ source: 'portal-inbox-draft-expired' }),
      }),
    );
    expect(h.deleteMany).not.toHaveBeenCalled();
  });

  it('keeps a missing intent retryable when the atomic evidence write fails', async () => {
    h.queryRaw.mockResolvedValue([
      candidate({
        storageVersionId: null,
        scanStatus: 'PENDING',
        decision: 'PENDING_REVIEW',
        batchStatus: 'EXPIRED',
      }),
    ]);
    h.record.mockRejectedValue(new Error('audit unavailable'));

    await expect(runPortalInboxCleanup(NOW)).resolves.toMatchObject({
      pendingWithoutObject: 1,
      removedMissingIntents: 0,
      failed: 1,
    });
    expect(h.deleteMany).toHaveBeenCalledOnce();
    expect(h.record).toHaveBeenCalledOnce();
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('fails closed when an object identity is already journaled for another tenant', async () => {
    h.queryRaw.mockResolvedValue([candidate()]);
    h.upsert.mockResolvedValue({ tenantId: '10000000-0000-4000-8000-000000000099' });

    await expect(runPortalInboxCleanup(NOW)).resolves.toMatchObject({
      queuedObjects: 0,
      failed: 1,
    });
    expect(h.log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'portal-inbox-cleanup',
        attachmentId: '20000000-0000-4000-8000-000000000001',
        tenantId: TENANT,
        errorType: 'Error',
      }),
      'portal inbox staging cleanup candidate failed',
    );
  });
});
