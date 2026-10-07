import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
  count: vi.fn(),
  documentVersionFindFirst: vi.fn(),
  riskAnalysisFindFirst: vi.fn(),
  deleteObjectVersion: vi.fn(),
  recoverPreparedBytesCommit: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../prisma-owner', () => ({
  prismaOwner: {
    storageOrphan: { findMany: h.findMany, updateMany: h.updateMany, count: h.count },
    documentVersion: { findFirst: h.documentVersionFindFirst },
    riskAnalysis: { findFirst: h.riskAnalysisFindFirst },
  },
}));
vi.mock('../../logger', () => ({ log: h.log }));
vi.mock('@taxtronik/storage', () => ({
  deleteObjectVersion: h.deleteObjectVersion,
  recoverPreparedBytesCommit: h.recoverPreparedBytesCommit,
}));

import { processors } from './mocks/bullmq';
import { startRunBudget } from '../../run-budget';
import { runStorageOrphanCleanup, storageOrphanCleanupWorker } from '../storage-orphan-cleanup';

const NOW = new Date('2026-08-23T12:00:00.000Z');

describe('storage orphan cleanup', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    h.findMany.mockResolvedValue([]);
    h.updateMany.mockResolvedValue({ count: 1 });
    h.count.mockResolvedValue(0);
    h.documentVersionFindFirst.mockResolvedValue(null);
    h.riskAnalysisFindFirst.mockResolvedValue(null);
    h.deleteObjectVersion.mockResolvedValue(undefined);
    h.recoverPreparedBytesCommit.mockResolvedValue(null);
  });

  it('DOC-UPLOAD-JOURNAL-001/P-17 lets later recoverable objects progress past a full batch of permanent errors in the same run', async () => {
    const rows = Array.from({ length: 101 }, (_, i) => ({
      id: `orphan-${i}`,
      tenantId: 't-1',
      storageBucket: 'general',
      storageKey: `tenants/t-1/${i}`,
      storageVersionId: i === 100 ? 'healthy-version' : '',
      sha256: Buffer.alloc(32),
      sizeBytes: 1n,
      immutable: false,
      retentionUntil: null,
      createdAt: new Date(NOW.getTime() - 3_600_000 + i),
      cleanedAt: null as Date | null,
      cleanupClaimedAt: null as Date | null,
      cleanupAttempts: 0,
    }));
    h.findMany.mockImplementation(
      async ({
        where,
        orderBy,
        take,
      }: {
        where: { id?: { notIn: string[] } };
        orderBy: Record<string, 'asc' | 'desc'> | Array<Record<string, 'asc' | 'desc'>>;
        take: number;
      }) =>
        rows
          .filter((r) => !r.cleanedAt && !where.id?.notIn.includes(r.id))
          .sort((a, b) => {
            for (const clause of Array.isArray(orderBy) ? orderBy : [orderBy]) {
              const [key, direction] = Object.entries(clause)[0]!;
              const left = a[key as 'cleanupAttempts'];
              const right = b[key as 'cleanupAttempts'];
              const order = left < right ? -1 : left > right ? 1 : 0;
              if (order) return direction === 'asc' ? order : -order;
            }
            return 0;
          })
          .slice(0, take),
    );
    h.updateMany.mockImplementation(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.find((r) => r.id === where.id)!;
        const { cleanupAttempts, ...fields } = data;
        Object.assign(row, fields);
        if (cleanupAttempts)
          row.cleanupAttempts += (cleanupAttempts as { increment: number }).increment;
        return { count: 1 };
      },
    );
    h.count.mockImplementation(async () => rows.filter((r) => !r.cleanedAt).length);

    // Batch 1: 100 dauerhafte Fehler; Batch 2 ohne die in diesem Lauf
    // gescheiterten Kandidaten: das wiederherstellbare Objekt.
    await expect(runStorageOrphanCleanup(NOW)).resolves.toEqual({
      claimed: 101,
      deleted: 1,
      referenced: 0,
      incidents: 0,
      absent: 0,
      failed: 100,
      backlog: 100,
      budgetExhausted: false,
    });
    expect(h.findMany).toHaveBeenCalledTimes(2);
    expect(h.findMany.mock.calls[1]![0].where.id.notIn).toHaveLength(100);
    expect(h.deleteObjectVersion).toHaveBeenCalledWith(
      'general',
      'tenants/t-1/100',
      'healthy-version',
    );
    expect(rows[100]!.cleanedAt).not.toBeNull();

    // Ein gescheiterter Kandidat bekommt höchstens einen Versuch je Lauf.
    expect((await runStorageOrphanCleanup(NOW)).failed).toBe(100);
    expect(rows.slice(0, 100).every((r) => r.cleanupAttempts === 2)).toBe(true);
  });

  describe('P-17: Nachlauf bis nichts mehr fällig ist oder das Zeitbudget endet', () => {
    function healthyRows(length: number) {
      return Array.from({ length }, (_, i) => ({
        id: `orphan-${String(i).padStart(3, '0')}`,
        tenantId: 't-1',
        storageBucket: 'general',
        storageKey: `tenants/t-1/${i}`,
        storageVersionId: `version-${i}`,
        cleanupAttempts: 0,
        cleanedAt: null as Date | null,
      }));
    }

    function serve(rows: ReturnType<typeof healthyRows>) {
      h.findMany.mockImplementation(async ({ take }: { take: number }) =>
        rows.filter((r) => !r.cleanedAt).slice(0, take),
      );
      h.updateMany.mockImplementation(
        async ({ where, data }: { where: { id: string }; data: { cleanedAt?: Date } }) => {
          if (data.cleanedAt) rows.find((r) => r.id === where.id)!.cleanedAt = data.cleanedAt;
          return { count: 1 };
        },
      );
      h.count.mockImplementation(async () => rows.filter((r) => !r.cleanedAt).length);
    }

    it('zieht Batch um Batch, bis kein fälliger Kandidat übrig ist', async () => {
      const rows = healthyRows(250);
      serve(rows);

      await expect(runStorageOrphanCleanup(NOW)).resolves.toEqual({
        claimed: 250,
        deleted: 250,
        referenced: 0,
        incidents: 0,
        absent: 0,
        failed: 0,
        backlog: 0,
        budgetExhausted: false,
      });
      // 100 + 100 + 50: der dritte, nicht volle Batch beendet den Lauf.
      expect(h.findMany).toHaveBeenCalledTimes(3);
      expect(h.deleteObjectVersion).toHaveBeenCalledTimes(250);
    });

    it('endet am Zeitbudget und meldet den Rückstand', async () => {
      const rows = healthyRows(250);
      serve(rows);
      let now = 0;
      h.deleteObjectVersion.mockImplementation(async () => {
        now += 4_000; // 4 s je Objekt -> 150 Objekte in 10 Minuten
      });

      const result = await runStorageOrphanCleanup(
        NOW,
        startRunBudget({ budgetMs: 10 * 60_000, clock: () => now }),
      );

      expect(result).toEqual({
        claimed: 150,
        deleted: 150,
        referenced: 0,
        incidents: 0,
        absent: 0,
        failed: 0,
        backlog: 100,
        budgetExhausted: true,
      });
      expect(h.count).toHaveBeenCalledWith({
        where: expect.objectContaining({ cleanedAt: null }),
      });
    });

    it('Worker: liefert das Ergebnis als Job-Rückgabe und hört beim Herunterfahren auf', async () => {
      serve(healthyRows(5));
      const proc = processors.get('storage-orphan-cleanup')!;

      await expect(proc({ data: {} })).resolves.toMatchObject({ deleted: 5, backlog: 0 });

      h.findMany.mockClear();
      const worker = storageOrphanCleanupWorker as unknown as { closing?: Promise<void> };
      worker.closing = Promise.resolve();
      try {
        serve(healthyRows(5));
        await expect(proc({ data: {} })).resolves.toMatchObject({
          claimed: 0,
          backlog: 5,
          budgetExhausted: true,
        });
        expect(h.findMany).not.toHaveBeenCalled();
      } finally {
        delete worker.closing;
      }
    });
  });

  it('selektiert Object-Lock-Orphans erst nach Retention und löscht versionsgenau', async () => {
    h.findMany.mockResolvedValue([
      {
        id: 'orphan-1',
        tenantId: 't-1',
        storageBucket: 'gobd',
        storageKey: 'tenants/t-1/gobd/file.bin',
        storageVersionId: 'locked-version-1',
      },
    ]);

    await expect(runStorageOrphanCleanup(NOW)).resolves.toEqual({
      claimed: 1,
      deleted: 1,
      referenced: 0,
      incidents: 0,
      absent: 0,
      failed: 0,
      backlog: 0,
      budgetExhausted: false,
    });

    expect(h.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          cleanedAt: null,
          createdAt: { lte: new Date('2026-08-23T11:30:00.000Z') },
          AND: [
            {
              OR: [
                { cleanupClaimedAt: null },
                { cleanupClaimedAt: { lte: new Date('2026-08-23T11:30:00.000Z') } },
              ],
            },
            { OR: [{ immutable: false }, { retentionUntil: { lte: NOW } }] },
          ],
        },
      }),
    );
    expect(h.deleteObjectVersion).toHaveBeenCalledWith(
      'gobd',
      'tenants/t-1/gobd/file.bin',
      'locked-version-1',
    );
    expect(h.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: 'orphan-1',
        cleanedAt: null,
        createdAt: { lte: new Date('2026-08-23T11:30:00.000Z') },
        AND: [
          {
            OR: [
              { cleanupClaimedAt: null },
              { cleanupClaimedAt: { lte: new Date('2026-08-23T11:30:00.000Z') } },
            ],
          },
          { OR: [{ immutable: false }, { retentionUntil: { lte: NOW } }] },
        ],
      },
      data: { cleanupClaimedAt: expect.any(Date) },
    });
    expect(h.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cleanedAt: expect.any(Date),
          cleanupClaimedAt: null,
          resolution: 'DELETED',
          cleanupAttempts: { increment: 1 },
        }),
      }),
    );
  });

  it('gibt den Claim nach Delete-Fehler frei und persistiert den Fehler für Retry', async () => {
    h.findMany.mockResolvedValue([
      {
        id: 'orphan-1',
        tenantId: 't-1',
        storageBucket: 'general',
        storageKey: 'tenants/t-1/general/key',
        storageVersionId: '',
        sha256: Buffer.alloc(32, 0x31),
        sizeBytes: 123n,
        immutable: false,
        retentionUntil: null,
      },
    ]);
    h.recoverPreparedBytesCommit.mockResolvedValue({
      targetBucket: 'general',
      targetKey: 'tenants/t-1/general/key',
      storageVersionId: 'recovered-version-1',
      sha256: Buffer.alloc(32, 0x31),
      sizeBytes: 123n,
      immutable: false,
      retentionUntil: null,
      detectedMime: null,
    });
    h.deleteObjectVersion.mockRejectedValue(new Error('object lock still active'));

    await expect(runStorageOrphanCleanup(NOW)).resolves.toEqual({
      claimed: 1,
      deleted: 0,
      referenced: 0,
      incidents: 0,
      absent: 0,
      failed: 1,
      backlog: 0,
      budgetExhausted: false,
    });
    expect(h.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: {
          cleanupClaimedAt: null,
          cleanupAttempts: { increment: 1 },
          cleanupError: 'object lock still active',
        },
      }),
    );
    expect(h.deleteObjectVersion).toHaveBeenCalledWith(
      'general',
      'tenants/t-1/general/key',
      'recovered-version-1',
    );
  });

  it('löscht nicht, wenn das Retention-Gate beim atomaren Claim inzwischen verloren ist', async () => {
    h.findMany.mockResolvedValue([
      {
        id: 'orphan-1',
        tenantId: 't-1',
        storageBucket: 'gobd',
        storageKey: 'tenants/t-1/gobd/key',
        storageVersionId: 'version-1',
      },
    ]);
    h.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(runStorageOrphanCleanup(NOW)).resolves.toEqual({
      claimed: 0,
      deleted: 0,
      referenced: 0,
      incidents: 0,
      absent: 0,
      failed: 0,
      backlog: 0,
      budgetExhausted: false,
    });
    expect(h.deleteObjectVersion).not.toHaveBeenCalled();
    expect(h.updateMany).toHaveBeenCalledOnce();
  });

  it('markiert eine persistierte DocumentVersion als REFERENCED und löscht nie das Objekt', async () => {
    h.findMany.mockResolvedValue([
      {
        id: 'orphan-1',
        tenantId: 't-1',
        storageBucket: 'general',
        storageKey: 'tenants/t-1/general/key',
        storageVersionId: 'version-1',
      },
    ]);
    h.documentVersionFindFirst.mockResolvedValue({
      id: 'document-version-1',
      document: { tenantId: 't-1' },
    });

    await expect(runStorageOrphanCleanup(NOW)).resolves.toEqual({
      claimed: 1,
      deleted: 0,
      referenced: 1,
      incidents: 0,
      absent: 0,
      failed: 0,
      backlog: 0,
      budgetExhausted: false,
    });

    expect(h.documentVersionFindFirst).toHaveBeenCalledWith({
      where: {
        storageBucket: 'general',
        storageKey: 'tenants/t-1/general/key',
        OR: [{ storageVersionId: 'version-1' }, { storageVersionId: null }],
      },
      select: { id: true, document: { select: { tenantId: true } } },
    });
    expect(h.deleteObjectVersion).not.toHaveBeenCalled();
    expect(h.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ resolution: 'REFERENCED', cleanedAt: expect.any(Date) }),
      }),
    );
  });

  // K-06: Risiko-Archiv und Engine-Rohergebnis sind Bezüge ohne Versionsspalte.
  it('markiert einen Verweis einer Risikoanalyse als REFERENCED und löscht nie das Objekt', async () => {
    h.findMany.mockResolvedValue([
      {
        id: 'orphan-1',
        tenantId: 't-1',
        storageBucket: 'gobd',
        storageKey: 'tenants/t-1/gobd/2026/10/raw.bin',
        storageVersionId: 'version-1',
      },
    ]);
    h.riskAnalysisFindFirst.mockResolvedValue({ id: 'analysis-1', tenantId: 't-1' });

    expect(await runStorageOrphanCleanup(NOW)).toMatchObject({
      claimed: 1,
      deleted: 0,
      referenced: 1,
      incidents: 0,
    });
    expect(h.riskAnalysisFindFirst).toHaveBeenCalledWith({
      where: {
        OR: [
          { rawResultBucket: 'gobd', rawResultKey: 'tenants/t-1/gobd/2026/10/raw.bin' },
          { archiveBucket: 'gobd', archiveKey: 'tenants/t-1/gobd/2026/10/raw.bin' },
        ],
      },
      select: { id: true, tenantId: true },
    });
    expect(h.deleteObjectVersion).not.toHaveBeenCalled();
    expect(h.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ resolution: 'REFERENCED', cleanedAt: expect.any(Date) }),
      }),
    );
  });

  it('wertet den Verweis einer fremden Risikoanalyse als Integritätsvorfall', async () => {
    h.findMany.mockResolvedValue([
      {
        id: 'orphan-1',
        tenantId: 't-1',
        storageBucket: 'gobd',
        storageKey: 'tenants/t-1/gobd/2026/10/archive.bin',
        storageVersionId: 'version-1',
      },
    ]);
    h.riskAnalysisFindFirst.mockResolvedValue({ id: 'analysis-foreign', tenantId: 't-2' });

    expect(await runStorageOrphanCleanup(NOW)).toMatchObject({ incidents: 1, deleted: 0 });
    expect(h.deleteObjectVersion).not.toHaveBeenCalled();
    expect(h.log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't-1',
        referencedTenantId: 't-2',
        referenceKind: 'risk_analysis',
        referenceId: 'analysis-foreign',
      }),
      expect.stringContaining('cross-tenant'),
    );
  });

  it('löscht bei fehlgeschlagener DB-Referenzprüfung nicht und gibt den Claim frei', async () => {
    h.findMany.mockResolvedValue([
      {
        id: 'orphan-1',
        tenantId: 't-1',
        storageBucket: 'general',
        storageKey: 'tenants/t-1/general/key',
        storageVersionId: 'version-1',
      },
    ]);
    h.documentVersionFindFirst.mockRejectedValue(new Error('database unavailable'));

    await expect(runStorageOrphanCleanup(NOW)).resolves.toEqual({
      claimed: 1,
      deleted: 0,
      referenced: 0,
      incidents: 0,
      absent: 0,
      failed: 1,
      backlog: 0,
      budgetExhausted: false,
    });
    expect(h.deleteObjectVersion).not.toHaveBeenCalled();
    expect(h.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cleanupClaimedAt: null,
          cleanupError: 'database unavailable',
        }),
      }),
    );
  });

  it('markiert einen Cross-Tenant-Treffer als Integritätsvorfall statt ihn still aufzulösen', async () => {
    h.findMany.mockResolvedValue([
      {
        id: 'orphan-1',
        tenantId: 't-1',
        storageBucket: 'general',
        storageKey: 'tenants/t-1/general/key',
        storageVersionId: 'version-1',
      },
    ]);
    h.documentVersionFindFirst.mockResolvedValue({
      id: 'document-version-foreign',
      document: { tenantId: 't-2' },
    });

    await expect(runStorageOrphanCleanup(NOW)).resolves.toEqual({
      claimed: 1,
      deleted: 0,
      referenced: 0,
      incidents: 1,
      absent: 0,
      failed: 0,
      backlog: 0,
      budgetExhausted: false,
    });
    expect(h.deleteObjectVersion).not.toHaveBeenCalled();
    expect(h.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          resolution: 'INTEGRITY_INCIDENT',
          cleanupError: 'INTEGRITY_CROSS_TENANT_STORAGE_REFERENCE',
        }),
      }),
    );
    expect(h.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't-1', referencedTenantId: 't-2' }),
      expect.stringContaining('cross-tenant'),
    );
  });

  it('markiert einen Tenant/Key-Prefix-Mismatch als Integritätsvorfall', async () => {
    h.findMany.mockResolvedValue([
      {
        id: 'orphan-1',
        tenantId: 't-1',
        storageBucket: 'general',
        storageKey: 'tenants/t-2/general/key',
        storageVersionId: 'version-1',
      },
    ]);

    await expect(runStorageOrphanCleanup(NOW)).resolves.toEqual({
      claimed: 1,
      deleted: 0,
      referenced: 0,
      incidents: 1,
      absent: 0,
      failed: 0,
      backlog: 0,
      budgetExhausted: false,
    });
    expect(h.documentVersionFindFirst).not.toHaveBeenCalled();
    expect(h.deleteObjectVersion).not.toHaveBeenCalled();
    expect(h.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          resolution: 'INTEGRITY_INCIDENT',
          cleanupError: 'INTEGRITY_TENANT_KEY_PREFIX_MISMATCH',
        }),
      }),
    );
  });

  it('DOC-UPLOAD-JOURNAL-001 bindet eine eindeutig recoverte Version vor der physischen Löschung', async () => {
    const sha256 = Buffer.alloc(32, 0x41);
    h.findMany.mockResolvedValue([
      {
        id: 'orphan-resume',
        tenantId: 't-1',
        storageBucket: 'gobd',
        storageKey: 'tenants/t-1/gobd/pending.bin',
        storageVersionId: '',
        sha256,
        sizeBytes: 456n,
        immutable: true,
        retentionUntil: new Date('2026-08-01T00:00:00.000Z'),
      },
    ]);
    h.recoverPreparedBytesCommit.mockResolvedValue({
      targetBucket: 'gobd',
      targetKey: 'tenants/t-1/gobd/pending.bin',
      storageVersionId: 'recovered-version-2',
      sha256,
      sizeBytes: 456n,
      immutable: true,
      retentionUntil: new Date('2026-08-01T00:00:00.000Z'),
      detectedMime: null,
    });

    await expect(runStorageOrphanCleanup(NOW)).resolves.toEqual({
      claimed: 1,
      deleted: 1,
      referenced: 0,
      incidents: 0,
      absent: 0,
      failed: 0,
      backlog: 0,
      budgetExhausted: false,
    });

    expect(h.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'orphan-resume',
          storageVersionId: '',
        }),
        data: { storageVersionId: 'recovered-version-2' },
      }),
    );
    expect(h.deleteObjectVersion).toHaveBeenCalledWith(
      'gobd',
      'tenants/t-1/gobd/pending.bin',
      'recovered-version-2',
    );
    expect(h.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ resolution: 'DELETED' }),
      }),
    );
  });

  describe('K-06: vor dem Object-Write journalisierte Speicherabsichten', () => {
    const intentRow = (overrides: Record<string, unknown> = {}) => ({
      id: 'intent-1',
      tenantId: 't-1',
      storageBucket: 'general',
      storageKey: 'tenants/t-1/none/2026/10/upload.bin',
      storageVersionId: '',
      sha256: Buffer.alloc(32, 0x61),
      sizeBytes: 12n,
      immutable: false,
      retentionUntil: null,
      intent: true,
      cleanupAttempts: 0,
      ...overrides,
    });

    it('schliesst eine nie geschriebene Absicht als ABSENT ab, ohne zu loeschen', async () => {
      h.findMany.mockResolvedValue([intentRow()]);
      h.recoverPreparedBytesCommit.mockResolvedValue(null);

      await expect(runStorageOrphanCleanup(NOW)).resolves.toEqual({
        claimed: 1,
        deleted: 0,
        referenced: 0,
        incidents: 0,
        absent: 1,
        failed: 0,
        backlog: 0,
        budgetExhausted: false,
      });
      expect(h.deleteObjectVersion).not.toHaveBeenCalled();
      expect(h.updateMany).toHaveBeenLastCalledWith({
        where: {
          id: 'intent-1',
          intent: true,
          storageVersionId: '',
          cleanedAt: null,
          cleanupClaimedAt: expect.any(Date),
        },
        data: expect.objectContaining({ resolution: 'ABSENT', cleanedAt: expect.any(Date) }),
      });
    });

    it('loescht das nach einem Abbruch unreferenzierte Objekt versionsgenau', async () => {
      h.findMany.mockResolvedValue([intentRow()]);
      h.recoverPreparedBytesCommit.mockResolvedValue({
        targetBucket: 'general',
        targetKey: 'tenants/t-1/none/2026/10/upload.bin',
        storageVersionId: 'crash-version',
      });

      expect((await runStorageOrphanCleanup(NOW)).deleted).toBe(1);
      expect(h.recoverPreparedBytesCommit).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 't-1',
          targetKey: 'tenants/t-1/none/2026/10/upload.bin',
          sha256: Buffer.alloc(32, 0x61),
          sizeBytes: 12n,
        }),
      );
      expect(h.deleteObjectVersion).toHaveBeenCalledWith(
        'general',
        'tenants/t-1/none/2026/10/upload.bin',
        'crash-version',
      );
    });

    it('erkennt den nach einem verlorenen Abschluss bereits committeten Bezug als REFERENCED', async () => {
      h.findMany.mockResolvedValue([intentRow()]);
      h.documentVersionFindFirst.mockResolvedValue({
        id: 'version-1',
        document: { tenantId: 't-1' },
      });

      expect((await runStorageOrphanCleanup(NOW)).referenced).toBe(1);
      expect(h.recoverPreparedBytesCommit).not.toHaveBeenCalled();
      expect(h.deleteObjectVersion).not.toHaveBeenCalled();
    });

    it('erkennt auch den committeten Verweis einer Risikoanalyse (Rohergebnis/Archiv)', async () => {
      // Verlorenes COMMIT-ACK: releaseStorageIntent fand die Absicht schon
      // abgeschlossen, die Kompensation journalisierte das Objekt erneut.
      h.findMany.mockResolvedValue([
        intentRow({
          storageBucket: 'gobd',
          storageKey: 'tenants/t-1/gobd/2026/10/archive.bin',
          immutable: true,
          retentionUntil: new Date('2026-01-01T00:00:00.000Z'),
        }),
      ]);
      h.riskAnalysisFindFirst.mockResolvedValue({ id: 'analysis-1', tenantId: 't-1' });

      expect((await runStorageOrphanCleanup(NOW)).referenced).toBe(1);
      expect(h.recoverPreparedBytesCommit).not.toHaveBeenCalled();
      expect(h.deleteObjectVersion).not.toHaveBeenCalled();
    });

    it('wertet fehlende Bytes eines nachgelagerten Orphans weiterhin als Fehler', async () => {
      h.findMany.mockResolvedValue([intentRow({ id: 'orphan-1', intent: false })]);
      h.recoverPreparedBytesCommit.mockResolvedValue(null);

      const result = await runStorageOrphanCleanup(NOW);

      expect(result).toMatchObject({ absent: 0, failed: 1 });
      expect(h.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ cleanupError: 'STORAGE_ORPHAN_VERSION_NOT_RECOVERED' }),
        }),
      );
    });

    it('waehlt Absichten nach demselben Retention-Gate wie Orphans aus', async () => {
      await runStorageOrphanCleanup(NOW);

      expect(h.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            cleanedAt: null,
            AND: expect.arrayContaining([
              { OR: [{ immutable: false }, { retentionUntil: { lte: NOW } }] },
            ]),
          }),
          select: expect.objectContaining({ intent: true }),
        }),
      );
    });
  });

  it('DOC-VERSION-IMMUTABILITY-001 löscht bei mehrdeutiger Recovery keine Version', async () => {
    h.findMany.mockResolvedValue([
      {
        id: 'orphan-ambiguous',
        tenantId: 't-1',
        storageBucket: 'gobd',
        storageKey: 'tenants/t-1/gobd/ambiguous.bin',
        storageVersionId: '',
        sha256: Buffer.alloc(32, 0x51),
        sizeBytes: 789n,
        immutable: true,
        retentionUntil: new Date('2026-08-01T00:00:00.000Z'),
      },
    ]);
    h.recoverPreparedBytesCommit.mockRejectedValue(new Error('PREPARED_UPLOAD_MULTIPLE_VERSIONS'));

    await expect(runStorageOrphanCleanup(NOW)).resolves.toEqual({
      claimed: 1,
      deleted: 0,
      referenced: 0,
      incidents: 0,
      absent: 0,
      failed: 1,
      backlog: 0,
      budgetExhausted: false,
    });
    expect(h.deleteObjectVersion).not.toHaveBeenCalled();
    expect(h.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cleanupClaimedAt: null,
          cleanupError: 'PREPARED_UPLOAD_MULTIPLE_VERSIONS',
        }),
      }),
    );
  });
});
