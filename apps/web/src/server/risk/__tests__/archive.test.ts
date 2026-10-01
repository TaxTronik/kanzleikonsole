// RISK-ARCHIVE-SNAPSHOT-001: real serializer/CAS helpers with an in-memory I/O seam.
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  withTenantContext: vi.fn(),
  upload: vi.fn(),
  record: vi.fn(),
  inTx: false,
}));
vi.mock('@taxtronik/db', () => ({ withTenantContext: h.withTenantContext }));
vi.mock('@taxtronik/storage', () => ({
  getBucketForTier: () => 'gobd',
  gobdRetentionUntil: () => new Date('2037-01-01'),
  putObjectBytes: h.upload,
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.record } }));
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
const update = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  current = row();
  h.inTx = false;
  h.upload.mockResolvedValue(undefined);
  h.record.mockResolvedValue(undefined);
  h.withTenantContext.mockImplementation(async (_ctx, fn) => {
    h.inTx = true;
    try {
      return await fn({
        $queryRaw: vi.fn(async () => [current]),
        riskAnalysis: { findFirst: vi.fn(async () => structuredClone(current)), update },
      });
    } finally {
      h.inTx = false;
    }
  });
});

describe('RISK-ARCHIVE-SNAPSHOT-001 archive upload and binding', () => {
  it('uploads a hash-verifiable gzip with rich document outside DB transactions', async () => {
    h.upload.mockImplementation(async () => {
      expect(h.inTx).toBe(false);
    });
    const result = await archiveAnalysis(ctx, 'analysis');
    const [, key, bytes] = h.upload.mock.calls[0]!;
    const json = gunzipSync(bytes);
    const payload = JSON.parse(json.toString());
    expect(payload.schemaVersion).toBe(2);
    expect(payload.sourceDoc).toEqual(current.sourceDoc);
    expect(payload.markings[0].matchedText).toBe('Text');
    expect(createHash('sha256').update(json).digest('hex')).toBe(result.snapshotHash);
    expect(key).toMatch(/^risk-archive\/tenant\/analysis\/[a-f0-9-]+\.json\.gz$/);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'analysis' },
      data: { archivedAt: new Date(payload.archivedAt), archiveBucket: 'gobd', archiveKey: key },
    });
    expect(h.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        after: expect.objectContaining({ snapshotHash: result.snapshotHash }),
      }),
    );
  });

  it('uses distinct keys for attempts and never binds stale uploaded content', async () => {
    h.upload.mockImplementationOnce(async () => {
      current.title = 'changed during upload';
    });
    await expect(archiveAnalysis(ctx, 'analysis')).rejects.toThrow(/zwischenzeitlich geändert/);
    expect(update).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
    await archiveAnalysis(ctx, 'analysis');
    expect(h.upload.mock.calls[0]![1]).not.toBe(h.upload.mock.calls[1]![1]);
  });

  it('does not bind or audit a failed storage write', async () => {
    h.upload.mockRejectedValueOnce(new Error('storage offline'));
    await expect(archiveAnalysis(ctx, 'analysis')).rejects.toThrow('storage offline');
    expect(update).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
  });

  it('refuses an already archived analysis before another upload', async () => {
    current.archivedAt = at;
    await expect(archiveAnalysis(ctx, 'analysis')).rejects.toThrow(/archiviert/);
    expect(h.upload).not.toHaveBeenCalled();
  });
});
