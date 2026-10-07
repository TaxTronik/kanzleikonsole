// Fachkatalog: DOC-UPLOAD-JOURNAL-001, RISK-ARCHIVE-SNAPSHOT-001
// =============================================================================
// K-06: Das Engine-Rohergebnis einer Risikoanalyse wird journal-first abgelegt:
// Speicherabsicht vor dem PUT, Abschluss in der Transaktion, die die Analyse
// mit dem Verweis anlegt. Object Store und Storage-Orphan-Journal sind das
// Journal-Double der Upload-Pfade (storage-journal-fake).
// =============================================================================

import { gunzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RiskAnalysisResult } from '@taxtronik/risk-layer';

const h = vi.hoisted(() => ({ withTenantContext: vi.fn(), create: vi.fn(), record: vi.fn() }));

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
import { saveAnalysis } from '../persistence';

const ctx = { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' as const };
const RAW = { engine: 'synthetic', treffer: [{ norm: '§ 15 EStG' }] };
const input = {
  sourceText: 'Verkauf einer Beteiligung',
  createdById: 'staff-1',
  result: {
    rawResult: RAW,
    textHash: null,
    katalogVersion: 'katalog-1',
    engineVersion: 'engine-1',
    markings: [],
  } as unknown as RiskAnalysisResult,
};

function analysisTx() {
  return {
    riskAnalysis: { create: h.create },
    $executeRaw: storageJournal.executeRaw,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  storageJournal.reset();
  h.create.mockImplementation(async ({ data }: { data: { id: string } }) => {
    storageJournal.events.push('create');
    return { id: data.id, _count: { markings: 0 } };
  });
  h.record.mockResolvedValue({});
  h.withTenantContext.mockImplementation(async (_ctx, fn) => fn(analysisTx()));
});

describe('Risikoanalyse: Rohergebnis journal-first (K-06)', () => {
  it('journalisiert vor dem PUT und schließt die Absicht mit dem Verweis atomar ab', async () => {
    const saved = await saveAnalysis(ctx, input);

    const stored = storageJournal.objects[0]!;
    expect(storageJournal.events).toEqual([
      'prepare',
      'journal',
      `put:${stored.key}`,
      'create',
      'settle',
    ]);
    expect(prepareBytesCommitWithTier).toHaveBeenCalledWith(
      expect.objectContaining({ tier: 'GOBD', tenantId: 'tenant-1', skipScan: true }),
    );
    const bytes = vi.mocked(commitPreparedBytes).mock.calls[0]![0].fileData;
    expect(JSON.parse(gunzipSync(bytes).toString('utf8'))).toEqual(RAW);
    expect(stored.key).toMatch(/^tenants\/tenant-1\/gobd\//);
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          id: saved.analysisId,
          rawResultBucket: stored.bucket,
          rawResultKey: stored.key,
        }),
      }),
    );
    expect(storageJournal.rows).toEqual([
      expect.objectContaining({
        source: 'risk.analysis.raw_result',
        intent: true,
        immutable: true,
        retentionUntil: expect.any(Date),
        resolution: 'REFERENCED',
        storageVersionId: stored.versionId,
      }),
    ]);
  });

  it('legt ohne Journal weder Objekt noch Analyse an', async () => {
    storageJournal.failJournal = new Error('journal unavailable');

    await expect(saveAnalysis(ctx, input)).rejects.toThrow('journal unavailable');
    expect(storageJournal.objects).toEqual([]);
    expect(h.withTenantContext).not.toHaveBeenCalled();
  });

  it('legt nach gescheitertem PUT keine Analyse an; die Absicht vermerkt den Fehler', async () => {
    storageJournal.failPut = new Error('storage offline');

    await expect(saveAnalysis(ctx, input)).rejects.toThrow('storage offline');
    expect(h.withTenantContext).not.toHaveBeenCalled();
    expect(storageJournal.openIntents()).toEqual([
      expect.objectContaining({ storageVersionId: '', failure: 'storage offline' }),
    ]);
  });

  it('lässt die Absicht mit gebundener Version offen, wenn die Analyse nicht entsteht', async () => {
    h.create.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(saveAnalysis(ctx, input)).rejects.toThrow('database unavailable');
    expect(compensateStorageCommit).not.toHaveBeenCalled();
    expect(storageJournal.openIntents()).toEqual([
      expect.objectContaining({
        source: 'risk.analysis.raw_result',
        storageVersionId: storageJournal.objects[0]!.versionId,
        failure: 'database unavailable',
      }),
    ]);
  });

  it('hinterlässt nach einem Abbruch zwischen PUT und Commit eine auflösbare Absicht', async () => {
    h.withTenantContext.mockImplementationOnce(() => processCrash());

    void saveAnalysis(ctx, input);
    await waitForEvent('put:');

    const [intent] = storageJournal.openIntents();
    expect(intent).toMatchObject({ source: 'risk.analysis.raw_result', storageVersionId: '' });
    expect(storageJournal.workerContract(intent!)).toEqual({
      selectable: true,
      tenantPrefix: true,
      objectVersions: 1,
      retentionGated: true,
    });
    expect(h.create).not.toHaveBeenCalled();
  });
});
