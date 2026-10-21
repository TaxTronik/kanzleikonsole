// Fachkatalog: TCMS-NACHWEIS-001, GWG-RETENTION-DESTRUCTION-001
// RT3D-K-01 (kk-tcms-fix5): Ablauf des Jobs gwg-object-lock-extend ohne
// Datenbank (Owner-Client und Object Store sind Attrappen). Auswahl und
// Buchführung gegen PostgreSQL: gwg-object-lock-extend-db.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeCandidate {
  tenantId: string;
  documentId: string;
  versionId: string;
  storageBucket: string;
  storageKey: string;
  storageVersionId: string | null;
  target: Date;
}

const h = vi.hoisted(() => ({
  candidates: [] as FakeCandidate[],
  query: vi.fn(),
  execute: vi.fn(),
  extend: vi.fn(),
  backlog: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {}, queues: {} }));
vi.mock('../../logger', () => ({ log: h.log }));
vi.mock('../../prisma-owner', () => ({
  prismaOwner: { $queryRaw: h.query, $executeRaw: h.execute },
}));
vi.mock('../../maintenance-backlog', () => ({ recordMaintenanceBacklog: h.backlog }));
vi.mock('@taxtronik/storage', () => ({
  getBucketForTier: (tier: string) => (tier === 'GWG' ? 'gwg-bucket' : 'falsch'),
  extendObjectLockRetention: h.extend,
}));

import { processors } from './mocks/bullmq';
import {
  GWG_OBJECT_LOCK_BATCH_SIZE,
  gwgObjectLockExtendWorker,
  lockErrorCode,
  runGwgObjectLockExtend,
} from '../gwg-object-lock-extend';

const ZIEL = new Date('2031-01-01T00:00:00Z');
const NO_LIMIT = { exhausted: () => false };

function candidate(n: number, extra: Partial<FakeCandidate> = {}): FakeCandidate {
  const id = String(n).padStart(12, '0');
  return {
    tenantId: 'tenant-a',
    documentId: `00000000-0000-4000-8000-${id}`,
    versionId: `11111111-0000-4000-8000-${id}`,
    storageBucket: 'gwg-bucket',
    storageKey: `tenants/tenant-a/gwg/${id}.pdf`,
    storageVersionId: `object-version-${n}`,
    target: ZIEL,
    ...extra,
  };
}

/** SQL-Text einer Prisma-Raw-Abfrage (Template-Strings). */
function sqlText(call: unknown[]): string {
  const strings = call[0] as { strings?: readonly string[] } | readonly string[];
  return (Array.isArray(strings) ? strings : (strings as { strings: string[] }).strings).join('?');
}

beforeEach(() => {
  vi.resetAllMocks();
  h.candidates.length = 0;
  // Auswahl: offene Kandidaten nach der Keyset-Grenze; Rückstand: keine Zeilen.
  h.query.mockImplementation(async (...call: unknown[]) => {
    const text = sqlText(call);
    if (text.includes('GROUP BY')) return [];
    const offen = h.candidates.splice(0, GWG_OBJECT_LOCK_BATCH_SIZE);
    return offen;
  });
  h.execute.mockResolvedValue(1);
  h.extend.mockImplementation(async (_ref: unknown, ziel: Date) => ({
    status: 'VERLAENGERT',
    mode: 'GOVERNANCE',
    retainUntil: ziel,
  }));
  h.backlog.mockResolvedValue({
    count: 0,
    oldestDueAt: null,
    consecutiveRuns: 0,
    alarm: false,
    threshold: { consecutiveRuns: 3, maxOverdueMs: 1 },
  });
});

describe('RT3D-K-01 gwg-object-lock-extend', () => {
  it('verlängert je Kandidat die exakte Objektversion bis zum Aufbewahrungsende und protokolliert Fehlschläge ohne Speicherangaben', async () => {
    h.candidates.push(
      candidate(1),
      candidate(2),
      candidate(3, { storageVersionId: null }),
      candidate(4),
    );
    h.extend.mockImplementation(async (ref: { key: string; versionId: string }, ziel: Date) => {
      if (!ref.versionId) {
        throw Object.assign(new Error('x'), { code: 'STORAGE_VERSION_ID_MISSING' });
      }
      if (ref.key.endsWith('000000000002.pdf')) {
        throw Object.assign(new Error('Access Denied for tenants/tenant-a/gwg/...'), {
          name: 'AccessDenied',
        });
      }
      if (ref.key.endsWith('000000000004.pdf')) {
        return { status: 'UNVERAENDERT', mode: 'GOVERNANCE', retainUntil: new Date('2040-01-01') };
      }
      return { status: 'VERLAENGERT', mode: 'GOVERNANCE', retainUntil: ziel };
    });

    const result = await runGwgObjectLockExtend(new Date('2026-10-21T12:00:00Z'), NO_LIMIT);
    expect(h.extend.mock.calls).toEqual([
      [{ bucket: 'gwg-bucket', key: candidate(1).storageKey, versionId: 'object-version-1' }, ZIEL],
      [{ bucket: 'gwg-bucket', key: candidate(2).storageKey, versionId: 'object-version-2' }, ZIEL],
      [{ bucket: 'gwg-bucket', key: candidate(3).storageKey, versionId: '' }, ZIEL],
      [{ bucket: 'gwg-bucket', key: candidate(4).storageKey, versionId: 'object-version-4' }, ZIEL],
    ]);
    expect(result).toMatchObject({
      examined: 4,
      extended: 1,
      unchanged: 1,
      failed: 2,
      backlog: 0,
      budgetExhausted: false,
    });
    // Je Kandidat genau ein Eintrag in gwg_object_lock_extension (Erfolg bzw. Fehlschlag).
    expect(h.execute).toHaveBeenCalledTimes(4);
    const fehler = h.log.error.mock.calls.map(([fields, msg]) => [fields, msg]);
    expect(fehler).toEqual([
      [
        expect.objectContaining({ versionId: candidate(2).versionId, code: 'AccessDenied' }),
        'gwg-object-lock-extend: Object-Lock nicht verlängert',
      ],
      [
        expect.objectContaining({
          versionId: candidate(3).versionId,
          code: 'STORAGE_VERSION_ID_MISSING',
        }),
        'gwg-object-lock-extend: Object-Lock nicht verlängert',
      ],
    ]);
    expect(JSON.stringify(fehler)).not.toMatch(/tenants\/|gwg-bucket|Access Denied/);
    expect(h.backlog).toHaveBeenCalledWith('gwgObjectLockExtend', [], expect.any(Date));
    expect(h.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ failed: 2 }),
      'gwg-object-lock-extend finished',
    );
  });

  it('liest stapelweise bis zum letzten nicht vollen Stapel, mit Keyset nach der Versions-ID', async () => {
    h.candidates.push(
      ...Array.from({ length: GWG_OBJECT_LOCK_BATCH_SIZE + 1 }, (_, i) => candidate(i + 1)),
    );
    const result = await runGwgObjectLockExtend(new Date(), NO_LIMIT);
    expect(result.examined).toBe(GWG_OBJECT_LOCK_BATCH_SIZE + 1);
    const auswahl = h.query.mock.calls.filter((call) => !sqlText(call).includes('GROUP BY'));
    expect(auswahl).toHaveLength(2);
    // Keyset: der zweite Stapel beginnt nach der letzten Versions-ID des ersten;
    // die Bedingung (eingebettetes Prisma.Sql) nennt den GwG-Bucket.
    expect(auswahl[0]![2]).toBeNull();
    expect(auswahl[1]![2]).toBe(candidate(GWG_OBJECT_LOCK_BATCH_SIZE).versionId);
    expect(JSON.stringify(auswahl[0])).toContain('"gwg-bucket"');
  });

  it('endet am Zeitbudget und meldet den Rückstand; der Worker liefert das Ergebnis und hört beim Herunterfahren auf', async () => {
    h.candidates.push(candidate(1), candidate(2));
    let schritte = 0;
    const result = await runGwgObjectLockExtend(new Date(), { exhausted: () => schritte++ >= 2 });
    expect(result).toMatchObject({ examined: 1, budgetExhausted: true });

    h.candidates.length = 0;
    h.candidates.push(candidate(3));
    const proc = processors.get('gwg-object-lock-extend')!;
    const worker = gwgObjectLockExtendWorker as unknown as { closing?: Promise<void> };
    worker.closing = Promise.resolve();
    try {
      await expect(proc({ data: {} })).resolves.toMatchObject({
        examined: 0,
        budgetExhausted: true,
      });
    } finally {
      delete worker.closing;
    }
    await expect(proc({ data: {} })).resolves.toMatchObject({ examined: 1, extended: 1 });
  });

  it('lockErrorCode: nur feste Codes, sonst UNBEKANNT', () => {
    expect(
      lockErrorCode(Object.assign(new Error('x'), { code: 'OBJECT_LOCK_EXTEND_UNVERIFIED' })),
    ).toBe('OBJECT_LOCK_EXTEND_UNVERIFIED');
    expect(lockErrorCode(Object.assign(new Error('x'), { name: 'AccessDenied' }))).toBe(
      'AccessDenied',
    );
    expect(lockErrorCode(Object.assign(new Error('x'), { code: 'bad code with spaces' }))).toBe(
      'UNBEKANNT',
    );
    expect(lockErrorCode('kaputt')).toBe('UNBEKANNT');
    expect(lockErrorCode(Object.assign(new Error('x'), { name: 'A'.repeat(65) }))).toBe(
      'UNBEKANNT',
    );
  });
});
