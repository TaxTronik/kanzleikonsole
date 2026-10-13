// Fachkatalog: DSGVO-CONTACT-EXPORT-001, DSGVO-REQUEST-EVIDENCE-001
// =============================================================================
// Welle 15 (Folgepunkt P-11): Ablauf des Workers dsgvo-export mit injizierten
// Abhängigkeiten (Transaktion, Paketaufbau, Object Store, Audit). Den Inhalt
// des Pakets und die Tabellen-Guards belegt
// packages/db/src/__tests__/dsgvo-contact-export.test.ts gegen PostgreSQL.
// =============================================================================
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@taxtronik/db', () => ({ withTenantContext: vi.fn() }));
vi.mock('@taxtronik/evidence', () => ({
  EvidenceService: class {
    record = vi.fn();
  },
  LocalTimestampAdapter: class {},
}));
vi.mock('@taxtronik/storage', () => {
  class UploadRejectedError extends Error {
    constructor(
      readonly reason: string,
      message: string,
    ) {
      super(`${reason}: ${message}`);
    }
  }
  return {
    UploadRejectedError,
    commitPreparedBytes: vi.fn(),
    deleteObject: vi.fn(),
    deleteObjectVersion: vi.fn(),
    prepareBytesCommitWithTier: vi.fn(),
  };
});

import { DsgvoContactExportError, serializeDsgvoExport } from '@taxtronik/db/dsgvo-contact-export';
import { UploadRejectedError } from '@taxtronik/storage';
import {
  DSGVO_EXPORT_BUILD_TX_OPTIONS,
  DSGVO_EXPORT_GENERIC_ERROR,
  processDsgvoExport,
  type DsgvoExportDeps,
} from '../dsgvo-export';

const TENANT = '10000000-0000-4000-8000-000000000015';
const EXPORT = '20000000-0000-4000-8000-000000000015';
const REQUEST = '30000000-0000-4000-8000-000000000015';
const CONTACT = '40000000-0000-4000-8000-000000000015';
const STAFF = '50000000-0000-4000-8000-000000000015';
const NOW = new Date('2026-10-12T10:00:00.000Z');

type Row = Record<string, unknown> & { id: string; status: string };

function harness(options: { requestStatus?: string; exportStatus?: string } = {}) {
  const exports: Row[] = [
    {
      id: EXPORT,
      tenantId: TENANT,
      requestId: REQUEST,
      contactId: CONTACT,
      requestedBy: STAFF,
      status: options.exportStatus ?? 'REQUESTED',
      storageKey: null,
    },
    {
      id: 'old-done',
      tenantId: TENANT,
      requestId: REQUEST,
      status: 'DONE',
      storageBucket: 'general',
      storageKey: `tenants/${TENANT}/none/old.bin`,
      storageVersionId: 'v-old',
      objectDeletedAt: null,
    },
  ];
  const requestUpdates: unknown[] = [];
  const txOptions: unknown[] = [];
  const steps: string[] = [];
  const tx = {
    $queryRaw: vi.fn(async () => [{ status: options.requestStatus ?? 'RECEIVED' }]),
    dsgvoRequest: {
      update: vi.fn(async (args: { data: unknown }) => {
        steps.push('request.update');
        requestUpdates.push(args.data);
        return {};
      }),
    },
    dsgvoExport: {
      findFirst: vi.fn(async (args: { where: { id: string; status: { in: string[] } } }) => {
        const row = exports.find((r) => r.id === args.where.id);
        return row && args.where.status.in.includes(row.status) ? { ...row } : null;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = exports.find((r) => r.id === args.where.id)!;
        for (const [key, value] of Object.entries(args.data)) {
          row[key] =
            key === 'attempts' ? ((row[key] as number | undefined) ?? 0) + 1 : (value as unknown);
        }
        steps.push(`export.update:${String(args.data['status'] ?? Object.keys(args.data)[0])}`);
        return { ...row };
      }),
      updateMany: vi.fn(
        async (args: { where: { id: string; status: { in: string[] } }; data: Row }) => {
          const row = exports.find((r) => r.id === args.where.id)!;
          if (!args.where.status.in.includes(row.status)) return { count: 0 };
          Object.assign(row, args.data);
          steps.push(`export.updateMany:${args.data.status}`);
          return { count: 1 };
        },
      ),
      findMany: vi.fn(async () =>
        exports.filter((r) => r.id !== EXPORT && r.status === 'DONE' && !r['objectDeletedAt']),
      ),
    },
  };
  const exportData = { contact: { id: CONTACT }, exportedAt: NOW.toISOString() };
  const deps: DsgvoExportDeps = {
    inSystemContext: vi.fn(async (_tenant, fn, opts) => {
      txOptions.push(opts ?? null);
      return fn(tx as never);
    }),
    build: vi.fn(async () => ({
      request: { id: REQUEST, status: 'RECEIVED' },
      contact: { id: CONTACT, email: 'erika@example.test' },
      exportData,
    })),
    prepare: vi.fn(async ({ fileData }) => {
      steps.push('prepare');
      return {
        tier: 'NONE' as const,
        tenantId: TENANT,
        targetBucket: 'general',
        targetKey: `tenants/${TENANT}/none/new.bin`,
        sha256: createHash('sha256').update(fileData).digest(),
        sizeBytes: BigInt(fileData.length),
        immutable: false,
        retentionUntil: null,
        detectedMime: null,
      };
    }),
    commit: vi.fn(async ({ prepared }) => {
      steps.push('commit');
      return { ...prepared, storageVersionId: 'v-new' };
    }),
    deleteStored: vi.fn(async (ref) => {
      steps.push(`delete:${ref.versionId}`);
    }),
    record: vi.fn(async () => {
      steps.push('audit');
      return {} as never;
    }),
    now: () => NOW,
  };
  return { deps, exports, requestUpdates, txOptions, steps, exportData };
}

describe('dsgvo-export (Welle 15, P-11)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('erzeugt das Paket, legt genau diese Bytes ab und bindet den Hash wie bisher', async () => {
    const h = harness();
    await expect(processDsgvoExport({ tenantId: TENANT, exportId: EXPORT }, h.deps)).resolves.toBe(
      'DONE',
    );
    const { serialized, sha256 } = serializeDsgvoExport(h.exportData);

    // Paketaufbau mit längerem Limit als im Webprozess, für die anfordernde Person.
    expect(h.deps.build).toHaveBeenCalledWith(expect.anything(), {
      tenantId: TENANT,
      requestId: REQUEST,
      contactId: CONTACT,
      exportedBy: STAFF,
      generatedAt: NOW,
    });
    expect(h.txOptions).toContainEqual(DSGVO_EXPORT_BUILD_TX_OPTIONS);
    // Ziel vor dem Schreiben vermerkt, dann exakt die serialisierten Bytes.
    expect(h.steps.indexOf('export.update:storageBucket')).toBeLessThan(h.steps.indexOf('commit'));
    const committed = vi.mocked(h.deps.commit).mock.calls[0]![0];
    expect(committed.fileData.toString('utf8')).toBe(serialized);

    const done = h.exports.find((r) => r.id === EXPORT)!;
    expect(done).toMatchObject({
      status: 'DONE',
      storageBucket: 'general',
      storageKey: `tenants/${TENANT}/none/new.bin`,
      storageVersionId: 'v-new',
      sizeBytes: BigInt(Buffer.byteLength(serialized, 'utf8')),
      finishedAt: NOW,
      attempts: 1,
    });
    expect(Buffer.from(done['sha256'] as Uint8Array).equals(sha256)).toBe(true);
    // Antrag wie bisher: Hash, Zeitpunkt, Person, Prüfung zurückgesetzt, IN_PROGRESS.
    const update = h.requestUpdates[0] as Record<string, unknown>;
    expect(Buffer.from(update['resultSha256'] as Uint8Array).equals(sha256)).toBe(true);
    expect(update).toMatchObject({
      resultPreparedAt: NOW,
      resultPreparedBy: STAFF,
      resultReviewedAt: null,
      resultReviewedBy: null,
      status: 'IN_PROGRESS',
    });
    expect(h.deps.record).toHaveBeenCalledWith(expect.anything(), {
      tenantId: TENANT,
      actorType: 'STAFF',
      actorId: STAFF,
      action: 'dsgvo.export.contact',
      resourceType: 'dsgvo_request',
      resourceId: REQUEST,
      after: {
        exportedFor: 'erika@example.test',
        contactId: CONTACT,
        sha256: sha256.toString('hex'),
        manualReviewRequired: true,
        exportId: EXPORT,
      },
    });
    // Überholtes Paket desselben Antrags erst nach dem Abschluss gelöscht.
    expect(h.steps.indexOf('delete:v-old')).toBeGreaterThan(h.steps.indexOf('audit'));
    expect(h.exports.find((r) => r.id === 'old-done')!['objectDeletedAt']).toEqual(NOW);
  });

  it('lässt den Antragsstatus IN_PROGRESS unverändert', async () => {
    const h = harness({ requestStatus: 'IN_PROGRESS' });
    await processDsgvoExport({ tenantId: TENANT, exportId: EXPORT }, h.deps);
    expect(h.requestUpdates[0]).not.toHaveProperty('status');
  });

  it('verwirft das abgelegte Paket, wenn der Antrag inzwischen abgeschlossen ist', async () => {
    const h = harness({ requestStatus: 'COMPLETED' });
    await expect(processDsgvoExport({ tenantId: TENANT, exportId: EXPORT }, h.deps)).resolves.toBe(
      'FAILED',
    );
    expect(h.requestUpdates).toEqual([]);
    expect(h.deps.record).not.toHaveBeenCalled();
    expect(h.deps.deleteStored).toHaveBeenCalledWith({
      bucket: 'general',
      key: `tenants/${TENANT}/none/new.bin`,
      versionId: 'v-new',
    });
    expect(h.exports.find((r) => r.id === EXPORT)).toMatchObject({
      status: 'FAILED',
      finishedAt: NOW,
      error: expect.stringContaining('zwischenzeitlich abgeschlossen'),
    });
    // Das bisherige Ergebnis bleibt erhalten.
    expect(h.exports.find((r) => r.id === 'old-done')!['objectDeletedAt']).toBeNull();
  });

  it.each([
    [
      new DsgvoContactExportError(
        'REQUEST_NOT_OPEN',
        'Passender offener DSGVO-Antrag nicht gefunden.',
      ),
      'Passender offener DSGVO-Antrag nicht gefunden.',
    ],
    [
      new UploadRejectedError('TOO_LARGE', 'Datei überschreitet das Limit.'),
      'TOO_LARGE: Datei überschreitet das Limit.',
    ],
    [new Error('relation "x" violates … Erika Mustermann'), DSGVO_EXPORT_GENERIC_ERROR],
  ])('endet bei %s als FAILED ohne Ablage und ohne Audit', async (error, message) => {
    const h = harness();
    vi.mocked(h.deps.build).mockRejectedValueOnce(error);
    await expect(processDsgvoExport({ tenantId: TENANT, exportId: EXPORT }, h.deps)).resolves.toBe(
      'FAILED',
    );
    expect(h.deps.commit).not.toHaveBeenCalled();
    expect(h.deps.record).not.toHaveBeenCalled();
    expect(h.exports.find((r) => r.id === EXPORT)).toMatchObject({
      status: 'FAILED',
      error: message,
    });
  });

  it.each(['DONE', 'FAILED'])(
    'überspringt einen bereits %s abgeschlossenen Auftrag',
    async (status) => {
      const h = harness({ exportStatus: status });
      await expect(
        processDsgvoExport({ tenantId: TENANT, exportId: EXPORT }, h.deps),
      ).resolves.toBe('SKIPPED');
      expect(h.deps.build).not.toHaveBeenCalled();
    },
  );
});
