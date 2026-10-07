// Fachkatalog: RISK-ARCHIVE-SNAPSHOT-001, DOC-UPLOAD-JOURNAL-001
// RISK-ARCHIVE-SNAPSHOT-001: real serializer/CAS helpers with an in-memory I/O seam.
// K-06: journal-first (intent before the PUT, settled with the archive pointer)
// against the storage journal double.
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  withTenantContext: vi.fn(),
  record: vi.fn(),
  inTx: false,
}));
vi.mock('@taxtronik/db', () => ({ withTenantContext: h.withTenantContext }));
vi.mock('@taxtronik/storage', async () => {
  const { storageJournal } = await import('@/server/documents/__tests__/storage-journal-fake');
  return {
    prepareBytesCommitWithTier: vi.fn(storageJournal.prepare),
    commitPreparedBytes: vi.fn(storageJournal.commit),
  };
});
vi.mock('@/server/db/prisma-owner', async () => {
  const { storageJournal } = await import('@/server/documents/__tests__/storage-journal-fake');
  return { prismaOwner: storageJournal.owner };
});
vi.mock('@/server/db/prisma-bytes', () => ({ prismaBytes: (bytes: unknown) => bytes }));
vi.mock('@/server/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('@/server/documents/storage-compensation', () => ({
  compensateStorageCommit: vi.fn(async () => 'JOURNALED'),
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.record } }));
import { commitPreparedBytes, prepareBytesCommitWithTier } from '@taxtronik/storage';
import { compensateStorageCommit } from '@/server/documents/storage-compensation';
import {
  processCrash,
  storageJournal,
  waitForEvent,
} from '@/server/documents/__tests__/storage-journal-fake';
import { archiveAnalysis } from '../archive';

const ctx = { tenantId: 'tenant', actorId: 'actor', actorType: 'STAFF' as const };
const at = new Date('2026-01-01');
const row = () => ({
  id: 'analysis',
  title: 'Review',
  clientId: 'client',
  client: { name: 'Synthetic' },
  documentId: null,
  sourceText: 'Text',
  sourceDoc: { type: 'doc', content: [] },
  textHash: 'hash',
  katalogVersion: 'catalog',
  engineVersion: 'engine',
  createdAt: at,
  createdById: 'actor',
  llmEnrichedAt: null,
  rawResultBucket: 'raw',
  rawResultKey: 'key',
  archivedAt: null as Date | null,
  vertraulich: false,
  markings: [
    { id: 'marking', start: 0, end: 4, matchedText: 'Text', createdAt: at, updatedAt: at },
  ],
});
let current: ReturnType<typeof row>;
const update = vi.fn(async () => {
  storageJournal.events.push('bind');
});
/** Bytes des n-ten Object-Writes. */
const written = (n = 0) => vi.mocked(commitPreparedBytes).mock.calls[n]![0].fileData;

beforeEach(() => {
  vi.clearAllMocks();
  storageJournal.reset();
  current = row();
  h.inTx = false;
  h.record.mockResolvedValue(undefined);
  h.withTenantContext.mockImplementation(async (_ctx, fn) => {
    h.inTx = true;
    try {
      return await fn({
        $queryRaw: vi.fn(async () => [current]),
        $executeRaw: storageJournal.executeRaw,
        riskAnalysis: { findFirst: vi.fn(async () => structuredClone(current)), update },
      });
    } finally {
      h.inTx = false;
    }
  });
});

describe('RISK-ARCHIVE-SNAPSHOT-001 archive upload and binding', () => {
  it('uploads a hash-verifiable gzip with rich document outside DB transactions', async () => {
    vi.mocked(commitPreparedBytes).mockImplementationOnce(async (input) => {
      expect(h.inTx).toBe(false);
      return storageJournal.commit(input);
    });
    const result = await archiveAnalysis(ctx, 'analysis');
    const json = gunzipSync(written());
    const payload = JSON.parse(json.toString());
    expect(payload.schemaVersion).toBe(2);
    expect(payload.sourceDoc).toEqual(current.sourceDoc);
    expect(payload.markings[0].matchedText).toBe('Text');
    expect(createHash('sha256').update(json).digest('hex')).toBe(result.snapshotHash);
    const stored = storageJournal.objects[0]!;
    expect(result).toMatchObject({ bucket: stored.bucket, key: stored.key });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'analysis' },
      data: {
        archivedAt: new Date(payload.archivedAt),
        archiveBucket: stored.bucket,
        archiveKey: stored.key,
      },
    });
    expect(h.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        after: expect.objectContaining({ snapshotHash: result.snapshotHash }),
      }),
    );
  });

  it('uses distinct keys for attempts and never binds stale uploaded content', async () => {
    vi.mocked(commitPreparedBytes).mockImplementationOnce(async (input) => {
      current.title = 'changed during upload';
      return storageJournal.commit(input);
    });
    await expect(archiveAnalysis(ctx, 'analysis')).rejects.toThrow(/zwischenzeitlich geändert/);
    expect(update).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
    await archiveAnalysis(ctx, 'analysis');
    expect(storageJournal.objects[0]!.key).not.toBe(storageJournal.objects[1]!.key);
  });

  it('does not bind or audit a failed storage write', async () => {
    storageJournal.failPut = new Error('storage offline');
    await expect(archiveAnalysis(ctx, 'analysis')).rejects.toThrow('storage offline');
    expect(update).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
  });

  it('refuses an already archived analysis before another upload', async () => {
    current.archivedAt = at;
    await expect(archiveAnalysis(ctx, 'analysis')).rejects.toThrow(/archiviert/);
    expect(prepareBytesCommitWithTier).not.toHaveBeenCalled();
    expect(storageJournal.events).toEqual([]);
  });
});

describe('K-06 / DOC-UPLOAD-JOURNAL-001: journal-first archive write', () => {
  it('journals the intent before the PUT and settles it with the archive pointer', async () => {
    await archiveAnalysis(ctx, 'analysis');

    const stored = storageJournal.objects[0]!;
    expect(storageJournal.events).toEqual([
      'prepare',
      'journal',
      `put:${stored.key}`,
      'bind',
      'settle',
    ]);
    expect(prepareBytesCommitWithTier).toHaveBeenCalledWith(
      expect.objectContaining({ tier: 'GOBD', tenantId: 'tenant', skipScan: true }),
    );
    expect(stored.key).toMatch(/^tenants\/tenant\/gobd\//);
    expect(storageJournal.rows).toEqual([
      expect.objectContaining({
        source: 'risk.analysis.archive',
        intent: true,
        immutable: true,
        resolution: 'REFERENCED',
        storageVersionId: stored.versionId,
        cleanedAt: expect.any(Date),
      }),
    ]);
  });

  it('writes nothing when the intent cannot be journaled', async () => {
    storageJournal.failJournal = new Error('journal unavailable');

    await expect(archiveAnalysis(ctx, 'analysis')).rejects.toThrow('journal unavailable');
    expect(storageJournal.objects).toEqual([]);
    expect(update).not.toHaveBeenCalled();
  });

  it('keeps the intent open with the bound version when binding fails after the PUT', async () => {
    vi.mocked(commitPreparedBytes).mockImplementationOnce(async (input) => {
      current.title = 'changed during upload';
      return storageJournal.commit(input);
    });

    await expect(archiveAnalysis(ctx, 'analysis')).rejects.toThrow(/zwischenzeitlich geändert/);
    expect(compensateStorageCommit).not.toHaveBeenCalled();
    expect(storageJournal.openIntents()).toEqual([
      expect.objectContaining({
        source: 'risk.analysis.archive',
        storageVersionId: storageJournal.objects[0]!.versionId,
        failure: expect.stringContaining('zwischenzeitlich geändert'),
      }),
    ]);
  });

  it('leaves a resolvable intent after a crash between PUT and commit', async () => {
    h.withTenantContext
      .mockImplementationOnce(async (_ctx, fn) =>
        fn({
          $queryRaw: vi.fn(async () => [current]),
          riskAnalysis: { findFirst: vi.fn(async () => structuredClone(current)), update },
        }),
      )
      .mockImplementationOnce(() => processCrash());

    void archiveAnalysis(ctx, 'analysis');
    await waitForEvent('put:');

    const [intent] = storageJournal.openIntents();
    expect(intent).toMatchObject({ source: 'risk.analysis.archive', storageVersionId: '' });
    expect(storageJournal.workerContract(intent!)).toEqual({
      selectable: true,
      tenantPrefix: true,
      objectVersions: 1,
      retentionGated: true,
    });
    expect(update).not.toHaveBeenCalled();
  });
});
