// Fachkatalog: GWG-IDENTIFICATION-EVIDENCE-001
// P-13: Nachtrag der Seitenzahl von PDF-Ausweisquellen. Auswahl, Stapel,
// Zeitbudget, Abbruch nach Fehlerserie und das Speichern nur für dieselbe
// Version (Hash, Objektversion) gegen eine Attrappe; die SQL-Auswahl und die
// Trigger prüft pdf-page-count-backfill-db.test.ts gegen PostgreSQL.
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeCandidate {
  tenantId: string;
  documentId: string;
  versionId: string;
  storageBucket: string;
  storageKey: string;
  storageVersionId: string;
  sha256: Uint8Array;
  sizeBytes: bigint;
}

const h = vi.hoisted(() => {
  class FakeStoredObjectError extends Error {
    constructor(
      readonly reason: string,
      readonly integrityViolation: boolean,
    ) {
      super(reason);
    }
  }
  return {
    FakeStoredObjectError,
    candidates: [] as FakeCandidate[],
    settled: new Map<string, number | null>(),
    contexts: [] as string[],
    queries: [] as Array<{ tenantId: string; after: string | null; limit: number }>,
    tenants: vi.fn(),
    fetch: vi.fn(),
    count: vi.fn(),
    execute: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../logger', () => ({ log: h.log }));
vi.mock('../../prisma-owner', () => ({ prismaOwner: { tenant: { findMany: h.tenants } } }));
vi.mock('@taxtronik/storage', () => ({
  fetchVerifiedObjectBytes: h.fetch,
  StoredObjectError: h.FakeStoredObjectError,
}));
vi.mock('@taxtronik/mail/pdf-page-count-node', () => ({ countPdfPagesInWorkerThread: h.count }));
vi.mock('@taxtronik/db', () => ({
  withSystemContext: async (tenantId: string, run: (tx: unknown) => unknown) => {
    h.contexts.push(tenantId);
    return run(fakeTx(tenantId));
  },
}));

/** Offene Kandidaten wie die SQL-Bedingung: ungeprüft, je Tenant nach Dokument-ID. */
function open(tenantId: string) {
  return h.candidates
    .filter((c) => c.tenantId === tenantId && !h.settled.has(c.versionId))
    .sort((a, b) => (a.documentId < b.documentId ? -1 : 1));
}

function fakeTx(tenantId: string) {
  return {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('count(*)')) return [{ open: BigInt(open(tenantId).length) }];
      const after = values[1] as string | null;
      const limit = values[3] as number;
      h.queries.push({ tenantId, after, limit });
      return open(tenantId)
        .filter((c) => after === null || c.documentId > after)
        .slice(0, limit)
        .map(({ tenantId: _tenant, ...row }) => row);
    },
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) =>
      h.execute(strings.join('?'), values),
  };
}

import { processors } from './mocks/bullmq';
import { startRunBudget } from '../../run-budget';
import {
  MAX_CONSECUTIVE_FAILURES,
  PDF_PAGE_COUNT_BATCH_SIZE,
  pdfPageCountBackfillWorker,
  runPdfPageCountBackfill,
} from '../pdf-page-count-backfill';

function candidate(tenantId: string, n: number): FakeCandidate {
  const id = String(n).padStart(12, '0');
  // Letztes Zeichen der Tenant-ID (a, b) als Hex-Ziffer: IDs je Tenant eindeutig.
  const t = tenantId.slice(-1);
  return {
    tenantId,
    documentId: `0000000${t}-0000-4000-8000-${id}`,
    versionId: `1111111${t}-0000-4000-8000-${id}`,
    storageBucket: 'gwg',
    storageKey: `tenants/${tenantId}/gwg/${id}.pdf`,
    storageVersionId: `object-version-${n}`,
    sha256: new Uint8Array(32).fill(n % 256),
    sizeBytes: 1024n,
  };
}

const NO_BUDGET_LIMIT = { exhausted: () => false };

beforeEach(() => {
  vi.resetAllMocks();
  h.candidates.length = 0;
  h.settled.clear();
  h.contexts.length = 0;
  h.queries.length = 0;
  h.tenants.mockResolvedValue([{ id: 'tenant-a' }]);
  h.fetch.mockImplementation(async (ref: { key: string }) => Buffer.from(`%PDF ${ref.key}`));
  h.count.mockResolvedValue({ status: 'counted', pages: 2 });
  h.execute.mockImplementation(async (_sql: string, values: unknown[]) => {
    const [pages, versionId] = values as [number | null, string];
    if (h.settled.has(versionId)) return 0;
    h.settled.set(versionId, pages);
    return 1;
  });
});

describe('P-13 pdf-page-count-backfill', () => {
  it('zählt, markiert nicht lesbare und abweichende Objekte und lässt Speicherfehler offen', async () => {
    h.candidates.push(...[1, 2, 3, 4].map((n) => candidate('tenant-a', n)));
    h.count.mockImplementation(async (bytes: Buffer) =>
      bytes.toString().endsWith('000000000002.pdf')
        ? { status: 'unreadable', reason: 'parser' }
        : { status: 'counted', pages: 7 },
    );
    h.fetch.mockImplementation(async (ref: { key: string }) => {
      if (ref.key.endsWith('000000000003.pdf')) throw new h.FakeStoredObjectError('HASH', true);
      if (ref.key.endsWith('000000000004.pdf')) throw new Error('S3 nicht erreichbar');
      return Buffer.from(`%PDF ${ref.key}`);
    });

    const result = await runPdfPageCountBackfill(NO_BUDGET_LIMIT);

    expect(result).toEqual({
      examined: 4,
      counted: 1,
      unreadable: 1,
      integrity: 1,
      skipped: 0,
      failed: 1,
      backlog: 1,
      budgetExhausted: false,
      aborted: false,
    });
    const c = (n: number) => candidate('tenant-a', n);
    expect(h.settled.get(c(1).versionId)).toBe(7);
    // Nicht lesbar und Hashabweichung: geprüft, ohne Seitenzahl.
    expect(h.settled.get(c(2).versionId)).toBeNull();
    expect(h.settled.get(c(3).versionId)).toBeNull();
    // Speicherfehler: kein Urteil, der nächste Lauf versucht es erneut.
    expect(h.settled.has(c(4).versionId)).toBe(false);
    // Bytes werden gegen Länge und SHA-256 der Version geprüft gelesen.
    expect(h.fetch).toHaveBeenCalledWith(
      { bucket: 'gwg', key: c(1).storageKey, versionId: c(1).storageVersionId },
      { sizeBytes: 1024n, sha256: Buffer.from(c(1).sha256) },
      { maxBytes: 25 * 1024 * 1024 },
    );
    expect(h.count).toHaveBeenCalledTimes(2);
  });

  it('speichert nur für dieselbe, ungeprüfte Version mit unveränderter Speicheridentität', async () => {
    const c = candidate('tenant-a', 1);
    h.candidates.push(c);

    await runPdfPageCountBackfill(NO_BUDGET_LIMIT);

    const [sql, values] = h.execute.mock.calls[0]! as [string, unknown[]];
    expect(sql).toContain('UPDATE "document_version"');
    expect(sql).toContain('"pdf_page_count" IS NULL');
    expect(sql).toContain('"pdf_page_count_checked_at" IS NULL');
    expect(sql).toContain('"sha256" = ?');
    expect(sql).toContain('"storage_version_id" = ?');
    expect(values).toEqual([
      2,
      c.versionId,
      c.documentId,
      Buffer.from(c.sha256),
      c.storageVersionId,
    ]);
    expect(h.contexts.every((tenantId) => tenantId === 'tenant-a')).toBe(true);
  });

  it('wertet eine inzwischen geänderte oder gesperrte Version als übersprungen', async () => {
    h.candidates.push(candidate('tenant-a', 1), candidate('tenant-a', 2));
    h.execute
      .mockResolvedValueOnce(0)
      .mockRejectedValueOnce(new Error('Zugeordneter GwG-Beweisinhalt ist unveraenderlich'));

    const result = await runPdfPageCountBackfill(NO_BUDGET_LIMIT);

    expect(result).toMatchObject({ examined: 2, counted: 0, skipped: 2, failed: 0 });
    expect(h.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: candidate('tenant-a', 2).documentId }),
      'pdf-page-count-backfill: Ergebnis nicht gespeichert',
    );
  });

  it('arbeitet in Stapeln per Keyset und je Tenant in dessen Kontext', async () => {
    h.tenants.mockResolvedValue([{ id: 'tenant-a' }, { id: 'tenant-b' }]);
    const many = PDF_PAGE_COUNT_BATCH_SIZE + 7;
    for (let n = 1; n <= many; n += 1) h.candidates.push(candidate('tenant-a', n));
    h.candidates.push(candidate('tenant-b', 1));

    const result = await runPdfPageCountBackfill(NO_BUDGET_LIMIT);

    expect(result).toMatchObject({ examined: many + 1, counted: many + 1, backlog: 0 });
    expect(h.queries).toEqual([
      { tenantId: 'tenant-a', after: null, limit: PDF_PAGE_COUNT_BATCH_SIZE },
      {
        tenantId: 'tenant-a',
        after: candidate('tenant-a', PDF_PAGE_COUNT_BATCH_SIZE).documentId,
        limit: PDF_PAGE_COUNT_BATCH_SIZE,
      },
      { tenantId: 'tenant-b', after: null, limit: PDF_PAGE_COUNT_BATCH_SIZE },
    ]);
  });

  it('endet am Zeitbudget und meldet den Rückstand; ein Folgelauf setzt fort', async () => {
    for (let n = 1; n <= 5; n += 1) h.candidates.push(candidate('tenant-a', n));
    let checks = 0;
    // Budget reicht für die Stapelabfrage und zwei Kandidaten.
    const budget = { exhausted: () => ++checks > 3 };

    const first = await runPdfPageCountBackfill(budget);
    expect(first).toMatchObject({ examined: 2, counted: 2, backlog: 3, budgetExhausted: true });

    const second = await runPdfPageCountBackfill(NO_BUDGET_LIMIT);
    expect(second).toMatchObject({ examined: 3, counted: 3, backlog: 0, budgetExhausted: false });
    // Idempotent: ein weiterer Lauf findet nichts mehr.
    const third = await runPdfPageCountBackfill(NO_BUDGET_LIMIT);
    expect(third).toMatchObject({ examined: 0, backlog: 0 });
  });

  it('bricht nach drei Speicher- bzw. Thread-Fehlern in Folge ab', async () => {
    for (let n = 1; n <= 6; n += 1) h.candidates.push(candidate('tenant-a', n));
    h.count.mockResolvedValue({ status: 'unavailable', reason: 'spawn' });

    const result = await runPdfPageCountBackfill(NO_BUDGET_LIMIT);

    expect(result).toMatchObject({
      examined: MAX_CONSECUTIVE_FAILURES,
      failed: MAX_CONSECUTIVE_FAILURES,
      backlog: 6,
      aborted: true,
      budgetExhausted: false,
    });
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ aborted: true }),
      'pdf-page-count-backfill finished',
    );
  });

  it('Worker: liefert das Ergebnis als Job-Rückgabe und hört beim Herunterfahren auf', async () => {
    h.candidates.push(candidate('tenant-a', 1));
    const proc = processors.get('pdf-page-count-backfill')!;
    const worker = pdfPageCountBackfillWorker as unknown as { closing?: Promise<void> };
    worker.closing = Promise.resolve();
    try {
      await expect(proc({ data: {} })).resolves.toMatchObject({
        examined: 0,
        backlog: 1,
        budgetExhausted: true,
      });
    } finally {
      delete worker.closing;
    }
    await expect(proc({ data: {} })).resolves.toMatchObject({ counted: 1, backlog: 0 });
    // Ohne Zeitangabe gilt das Budget der Wartungsjobs.
    expect(startRunBudget().exhausted()).toBe(false);
  });
});
