// =============================================================================
// Unit-Tests: audit-rotate-Worker (segmentweise Archivierung der Audit-Chain).
//
// bullmq via mocks/bullmq.ts; Prisma/S3/Evidence/SSRF-Guard per vi.mock —
// die Command-Klassen (HeadObjectCommand/PutObjectCommand) bleiben echt, damit
// der Mock per instanceof unterscheiden kann. Abgedeckt:
//   - RF-11: Segment-Selektion als REINE id-Range (erst max(id) mit
//     occurredAt <= cutoff, dann gt sinceId / lte maxId) — keine Lücken bei
//     nicht-monotoner Uhr
//   - PUT mit Object-Lock COMPLIANCE + GoBD-Retention + SHA-256-Checksum
//   - N-8 Forward-Recovery: Objekt existiert bereits → kein zweiter PUT,
//     DB-Eintrag wird nachgezogen
//   - echte S3-Fehler beim HeadObject propagieren (nur NotFound ist erwartet)
//   - F3: optionaler RFC-3161-Stempel; Fehlschlag → tsaResponseBlob NULL
//   - RF-13: AUDIT_ARCHIVE_MODE=HARD wird ehrlich als SOFT persistiert
//     (DB-Cleanup nicht implementiert — kein irreführender HARD-Nachweis)
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => {
  const prismaOwner = {
    tenant: { findMany: vi.fn() },
    auditArchive: { findFirst: vi.fn(), create: vi.fn() },
    auditLog: { aggregate: vi.fn(), findMany: vi.fn() },
    tenantSetting: { findUnique: vi.fn() },
  };
  const s3Send = vi.fn();
  const serializeArchive = vi.fn();
  const tsaTimestamp = vi.fn();
  const assertPublicHost = vi.fn();
  const retention = new Date('2036-12-31T23:59:59.000Z');
  // RF-13: hoisted, damit der Logger auch nach vi.resetModules() (HARD-Test
  // unten) objekt-identisch geteilt bleibt und Warn-Assertions möglich sind.
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { prismaOwner, s3Send, serializeArchive, tsaTimestamp, assertPublicHost, retention, log };
});

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../prisma-owner', () => ({ prismaOwner: h.prismaOwner }));
vi.mock('../../logger', () => ({ log: h.log }));
vi.mock('../../http/ssrf-guard', () => ({ assertPublicHost: h.assertPublicHost }));
vi.mock('@taxtronik/config', () => ({ env: { S3_BUCKET_GOBD: 'gobd-bucket' } }));
vi.mock('@taxtronik/storage', () => ({
  s3: { send: h.s3Send },
  gobdRetentionUntil: () => h.retention,
}));
vi.mock('@taxtronik/evidence', () => ({
  serializeArchive: h.serializeArchive,
  createRfc3161Adapter: () => ({ timestamp: h.tsaTimestamp }),
  resolveTsaUrl: (providerId: string | null, customUrl: string | null) =>
    customUrl ?? (providerId ? `https://tsa.example.com/${providerId}` : null),
}));

import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { processors } from './mocks/bullmq';
import '../audit-rotate';

const FIXED_NOW = new Date('2026-06-09T10:00:00.000Z');
// MIN_AGE_DAYS = 90 → cutoff exakt 90 Tage vor FIXED_NOW
const CUTOFF = new Date('2026-03-11T10:00:00.000Z');
const TENANT = 'tenant-1';

const NDJSON = Buffer.from('{"id":"6"}\n{"id":"7"}\n');
const SER = {
  fromAuditId: 6n,
  toAuditId: 7n,
  entryCount: 2,
  fromOccurredAt: new Date('2026-01-15T08:00:00.000Z'),
  toOccurredAt: new Date('2026-02-01T09:00:00.000Z'),
  ndjson: NDJSON,
  fileSha256: Buffer.alloc(32, 0xab),
  firstPrevHash: Buffer.alloc(32, 0),
  lastThisHash: Buffer.alloc(32, 2),
};

interface RotateResult {
  totalArchived: number;
  totalDeleted: number;
}

function run(): Promise<RotateResult> {
  return processors.get('audit-rotate')!({ data: { tenantId: TENANT } }) as Promise<RotateResult>;
}

function auditRow(id: bigint) {
  return {
    id,
    tenantId: TENANT,
    occurredAt: new Date('2026-01-15T08:00:00.000Z'),
    actorType: 'SYSTEM',
    actorId: null,
    action: 'test.action',
    resourceType: 'test',
    resourceId: String(id),
    before: null,
    after: null,
    ip: null,
    userAgent: null,
    prevHash: Buffer.alloc(32, 1),
    thisHash: Buffer.alloc(32, 2),
  };
}

function notFound(): Error {
  return Object.assign(new Error('NotFound'), {
    name: 'NotFound',
    $metadata: { httpStatusCode: 404 },
  });
}

function sentCommands(): unknown[] {
  return h.s3Send.mock.calls.map((c) => c[0]);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  vi.resetAllMocks();
  h.prismaOwner.tenant.findMany.mockResolvedValue([{ id: TENANT }]);
  h.prismaOwner.auditArchive.findFirst.mockResolvedValue({ toAuditId: 5n });
  h.prismaOwner.auditArchive.create.mockResolvedValue({});
  h.prismaOwner.auditLog.aggregate.mockResolvedValue({ _max: { id: 7n } });
  h.prismaOwner.auditLog.findMany.mockResolvedValue([auditRow(6n), auditRow(7n)]);
  h.prismaOwner.tenantSetting.findUnique.mockResolvedValue(null);
  h.serializeArchive.mockReturnValue(SER);
  // Default: Objekt existiert noch nicht (HeadObject → NotFound), PUT klappt
  h.s3Send.mockImplementation(async (cmd: unknown) => {
    if (cmd instanceof HeadObjectCommand) throw notFound();
    return {};
  });
  h.assertPublicHost.mockResolvedValue(undefined);
  h.tsaTimestamp.mockResolvedValue({ tsaResponseBlob: Buffer.from('tsa-stamp') });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RF-11: Segment-Selektion als reine id-Range', () => {
  it('bestimmt erst max(id) per occurredAt-Cutoff, lädt dann gt sinceId / lte maxId', async () => {
    const result = await run();

    expect(h.prismaOwner.auditLog.aggregate).toHaveBeenCalledWith({
      _max: { id: true },
      where: { tenantId: TENANT, occurredAt: { lte: CUTOFF } },
    });
    // KEIN occurredAt im findMany — die Range ist per Konstruktion lückenlos
    expect(h.prismaOwner.auditLog.findMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT, id: { gt: 5n, lte: 7n } },
      orderBy: { id: 'asc' },
      take: 5000,
    });
    expect(result).toEqual({ totalArchived: 2, totalDeleted: 0 });
  });

  it('noch nie archiviert → Range startet bei id > 0', async () => {
    h.prismaOwner.auditArchive.findFirst.mockResolvedValue(null);

    await run();

    expect(h.prismaOwner.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: TENANT, id: { gt: 0n, lte: 7n } },
      }),
    );
  });

  it('keine Einträge alt genug (max null) → Tenant wird übersprungen', async () => {
    h.prismaOwner.auditLog.aggregate.mockResolvedValue({ _max: { id: null } });

    const result = await run();

    expect(h.prismaOwner.auditLog.findMany).not.toHaveBeenCalled();
    expect(h.s3Send).not.toHaveBeenCalled();
    expect(h.prismaOwner.auditArchive.create).not.toHaveBeenCalled();
    expect(result).toEqual({ totalArchived: 0, totalDeleted: 0 });
  });

  it('alles bereits archiviert (maxId <= sinceId) → kein neues Segment', async () => {
    h.prismaOwner.auditLog.aggregate.mockResolvedValue({ _max: { id: 5n } });

    const result = await run();

    expect(h.prismaOwner.auditLog.findMany).not.toHaveBeenCalled();
    expect(result).toEqual({ totalArchived: 0, totalDeleted: 0 });
  });
});

describe('Upload + Archiv-Eintrag', () => {
  it('PUT mit Object-Lock COMPLIANCE, GoBD-Retention und SHA-256-Checksum', async () => {
    await run();

    const puts = sentCommands().filter((c) => c instanceof PutObjectCommand);
    expect(puts).toHaveLength(1);
    expect((puts[0] as PutObjectCommand).input).toEqual({
      Bucket: 'gobd-bucket',
      Key: `tenants/${TENANT}/audit-archive/2026/01/6-7.ndjson`,
      Body: NDJSON,
      ContentLength: NDJSON.length,
      ContentType: 'application/x-ndjson',
      ChecksumSHA256: SER.fileSha256.toString('base64'),
      ObjectLockMode: 'COMPLIANCE',
      ObjectLockRetainUntilDate: h.retention,
    });
    expect(h.prismaOwner.auditArchive.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: TENANT,
        fromAuditId: 6n,
        toAuditId: 7n,
        entryCount: 2,
        fileSizeBytes: BigInt(NDJSON.length),
        storageBucket: 'gobd-bucket',
        storageKey: `tenants/${TENANT}/audit-archive/2026/01/6-7.ndjson`,
        tsaResponseBlob: expect.any(Uint8Array), // verifizierter GlobalSign-Default
        mode: 'SOFT',
      }),
    });
  });

  it('serializeArchive erhält die geladenen Zeilen mit Buffer-Hashes', async () => {
    await run();

    expect(h.serializeArchive).toHaveBeenCalledTimes(1);
    const rows = h.serializeArchive.mock.calls[0]![0] as Array<{ id: bigint; prevHash: Buffer }>;
    expect(rows.map((r) => r.id)).toEqual([6n, 7n]);
    expect(Buffer.isBuffer(rows[0]!.prevHash)).toBe(true);
  });
});

describe('N-8: Forward-Recovery nach Crash zwischen PUT und DB-Insert', () => {
  it('Objekt existiert bereits → kein zweiter PUT, DB-Eintrag wird nachgezogen', async () => {
    h.s3Send.mockResolvedValue({}); // HeadObject findet das Objekt

    const result = await run();

    const cmds = sentCommands();
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toBeInstanceOf(HeadObjectCommand);
    expect(h.prismaOwner.auditArchive.create).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ totalArchived: 2, totalDeleted: 0 });
  });

  it('echter S3-Fehler beim HeadObject propagiert (nur NotFound ist erwartet)', async () => {
    h.s3Send.mockRejectedValue(
      Object.assign(new Error('internal error'), {
        name: 'InternalError',
        $metadata: { httpStatusCode: 500 },
      }),
    );

    await expect(run()).rejects.toThrow('internal error');
    expect(h.prismaOwner.auditArchive.create).not.toHaveBeenCalled();
  });
});

describe('F3: optionaler RFC-3161-Stempel', () => {
  it('ohne Override nutzt das Archiv denselben GlobalSign-Default wie die Tagessiegel', async () => {
    await run();

    expect(h.assertPublicHost).toHaveBeenCalledWith('https://tsa.example.com/globalsign', {
      mode: 'public',
    });
    expect(h.tsaTimestamp).toHaveBeenCalledWith(SER.fileSha256);
  });

  it('Tenant-TSA konfiguriert → Stempel über fileSha256, Blob landet im Archiv', async () => {
    h.prismaOwner.tenantSetting.findUnique.mockResolvedValue({
      value: { customUrl: 'https://tsa.example.com/tsr' },
    });

    await run();

    expect(h.assertPublicHost).toHaveBeenCalledWith('https://tsa.example.com/tsr', {
      mode: 'public',
    });
    expect(h.tsaTimestamp).toHaveBeenCalledWith(SER.fileSha256);
    const data = h.prismaOwner.auditArchive.create.mock.calls[0]![0].data as {
      tsaResponseBlob: Uint8Array;
    };
    expect(Buffer.from(data.tsaResponseBlob).toString()).toBe('tsa-stamp');
  });

  it('TSA-Fehlschlag → tsaResponseBlob NULL, Archivierung läuft trotzdem durch', async () => {
    h.prismaOwner.tenantSetting.findUnique.mockResolvedValue({
      value: { customUrl: 'https://tsa.example.com/tsr' },
    });
    h.tsaTimestamp.mockRejectedValue(new Error('TSA timeout'));

    const result = await run();

    expect(h.prismaOwner.auditArchive.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ tsaResponseBlob: null }),
    });
    expect(result).toEqual({ totalArchived: 2, totalDeleted: 0 });
  });
});

describe('RF-13: AUDIT_ARCHIVE_MODE=HARD wird ehrlich als SOFT persistiert', () => {
  // MODE wird beim Modul-Load gelesen → frische Modul-Instanz mit gestubbter
  // ENV. Achtung: vi.resetModules() leert die Modul-Registry — der neue Worker
  // registriert sich in einer NEUEN processors-Map (mocks/bullmq wird ebenfalls
  // neu instanziiert), daher holen wir den Processor aus der frischen Map.
  // Die hoisted h.*-Mocks sind objekt-identisch geteilt und gelten weiter.
  it('mode=HARD → Archiv-Eintrag mit mode SOFT, totalDeleted bleibt 0', async () => {
    vi.stubEnv('AUDIT_ARCHIVE_MODE', 'HARD');
    vi.resetModules();
    try {
      const fresh = (await import('./mocks/bullmq')).processors;
      await import('../audit-rotate');
      // Je nachdem, ob vitest die bullmq-Mock-Factory neu evaluiert, landet
      // der frische Processor in der neuen ODER der alten Map — beide prüfen.
      const proc = fresh.get('audit-rotate') ?? processors.get('audit-rotate');
      const result = (await proc!({ data: { tenantId: TENANT } })) as RotateResult;

      // Warn-Hinweis beweist, dass wirklich die HARD-Konfiguration lief
      // (kein vakuum-grüner Lauf des alten SOFT-Moduls).
      expect(h.log.warn).toHaveBeenCalledWith(expect.stringContaining('AUDIT_ARCHIVE_MODE=HARD'));
      expect(h.prismaOwner.auditArchive.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ mode: 'SOFT' }),
      });
      expect(result).toEqual({ totalArchived: 2, totalDeleted: 0 });
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
