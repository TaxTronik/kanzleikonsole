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
//   - F3/F-12: RFC-3161-Stempel über resolveTsa (wie Siegel und Anker);
//     Fehlschlag → tsaResponseBlob NULL + tsa_status PENDING, späterer Lauf
//     stempelt nach geprüftem Objekt nach (STAMPED_LATE)
//   - RF-13: AUDIT_ARCHIVE_MODE=HARD wird ehrlich als SOFT persistiert
//     (DB-Cleanup nicht implementiert — kein irreführender HARD-Nachweis)
// Fachkatalog: AUDIT-ARCHIVE-001, AUDIT-RFC3161-ANCHOR-001
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

const h = vi.hoisted(() => {
  const prismaOwner = {
    tenant: { findMany: vi.fn() },
    auditArchive: {
      findFirst: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    auditLog: { aggregate: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    tenantSetting: { findUnique: vi.fn() },
  };
  const s3Send = vi.fn();
  const serializeArchive = vi.fn();
  const parseArchive = vi.fn();
  const verifyArchiveChain = vi.fn();
  const tsaTimestamp = vi.fn();
  const tsaVerify = vi.fn();
  const resolveTsa = vi.fn();
  const retention = new Date('2036-12-31T23:59:59.000Z');
  // RF-13: hoisted, damit der Logger auch nach vi.resetModules() (HARD-Test
  // unten) objekt-identisch geteilt bleibt und Warn-Assertions möglich sind.
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    prismaOwner,
    s3Send,
    serializeArchive,
    parseArchive,
    verifyArchiveChain,
    tsaTimestamp,
    tsaVerify,
    resolveTsa,
    retention,
    log,
  };
});

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../prisma-owner', () => ({ prismaOwner: h.prismaOwner }));
vi.mock('../../logger', () => ({ log: h.log }));
vi.mock('../../tsa-port', () => ({ resolveTsa: h.resolveTsa }));
vi.mock('@taxtronik/config', () => ({ env: { S3_BUCKET_GOBD: 'gobd-bucket' } }));
vi.mock('@taxtronik/storage', () => ({
  s3: { send: h.s3Send },
  gobdRetentionUntil: () => h.retention,
}));
vi.mock('@taxtronik/evidence', () => ({
  serializeArchive: h.serializeArchive,
  parseArchive: h.parseArchive,
  verifyArchiveChain: h.verifyArchiveChain,
}));

import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { processors } from './mocks/bullmq';
import { auditRotateWorker } from '../audit-rotate';

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
  fileSha256: createHash('sha256').update(NDJSON).digest(),
  firstPrevHash: Buffer.alloc(32, 0),
  lastThisHash: Buffer.alloc(32, 2),
};

interface RotateResult {
  totalArchived: number;
  totalDeleted: number;
  restamped: number;
  restampRejected: number;
  segments: number;
  backlog: number;
  pendingStamps: number;
  budgetExhausted: boolean;
}

const NOTHING: RotateResult = {
  totalArchived: 0,
  totalDeleted: 0,
  restamped: 0,
  restampRejected: 0,
  segments: 0,
  backlog: 0,
  pendingStamps: 0,
  budgetExhausted: false,
};
const ROTATED: RotateResult = { ...NOTHING, totalArchived: 2, segments: 1 };

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
  h.prismaOwner.auditArchive.findMany.mockResolvedValue([]);
  h.prismaOwner.auditArchive.updateMany.mockResolvedValue({ count: 1 });
  h.prismaOwner.auditArchive.count.mockResolvedValue(0);
  h.prismaOwner.auditLog.count.mockResolvedValue(0);
  h.prismaOwner.auditLog.aggregate.mockResolvedValue({ _max: { id: 7n } });
  h.prismaOwner.auditLog.findMany.mockResolvedValue([auditRow(6n), auditRow(7n)]);
  h.prismaOwner.tenantSetting.findUnique.mockResolvedValue(null);
  h.serializeArchive.mockReturnValue(SER);
  h.parseArchive.mockReturnValue([]);
  h.verifyArchiveChain.mockReturnValue({ ok: true });
  // Default: Objekt existiert noch nicht (HeadObject → NotFound), PUT klappt
  h.s3Send.mockImplementation(async (cmd: unknown) => {
    if (cmd instanceof HeadObjectCommand) throw notFound();
    return {};
  });
  h.resolveTsa.mockResolvedValue({
    port: { mode: 'rfc3161', timestamp: h.tsaTimestamp, verify: h.tsaVerify },
    url: 'https://tsa.example.com/globalsign',
    source: 'default',
  });
  h.tsaTimestamp.mockResolvedValue({
    tsaResponseBlob: Buffer.from('tsa-stamp'),
    tsaSerial: '0a1b',
  });
  h.tsaVerify.mockResolvedValue(true);
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
    expect(result).toEqual(ROTATED);
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
    expect(result).toEqual(NOTHING);
  });

  it('alles bereits archiviert (maxId <= sinceId) → kein neues Segment', async () => {
    h.prismaOwner.auditLog.aggregate.mockResolvedValue({ _max: { id: 5n } });

    const result = await run();

    expect(h.prismaOwner.auditLog.findMany).not.toHaveBeenCalled();
    expect(result).toEqual(NOTHING);
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
      IfNoneMatch: '*',
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
        tsaResponseBlob: expect.any(Uint8Array), // gegen Datei-Hash verifizierter Token
        tsaSerial: '0a1b',
        tsaStatus: 'STAMPED',
        tsaStampedAt: FIXED_NOW,
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
    h.s3Send.mockImplementation(async (cmd: unknown) =>
      cmd instanceof GetObjectCommand
        ? { ContentLength: NDJSON.length, Body: Readable.from([NDJSON]) }
        : {},
    );

    const result = await run();

    const cmds = sentCommands();
    expect(cmds).toHaveLength(2);
    expect(cmds[0]).toBeInstanceOf(HeadObjectCommand);
    expect(cmds[1]).toBeInstanceOf(GetObjectCommand);
    expect(h.prismaOwner.auditArchive.create).toHaveBeenCalledTimes(1);
    expect(result).toEqual(ROTATED);
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

describe('AUDIT-ARCHIVE-001: Segment vor Upload und Recovery vollständig prüfen', () => {
  it.each([false, true])('prüft reale Kettenzeilen (manipuliert: %s)', async (tampered) => {
    const actual =
      await vi.importActual<typeof import('@taxtronik/evidence')>('@taxtronik/evidence');
    h.serializeArchive.mockImplementation(actual.serializeArchive);
    h.parseArchive.mockImplementation(actual.parseArchive);
    h.verifyArchiveChain.mockImplementation(actual.verifyArchiveChain);
    const first = auditRow(6n);
    first.thisHash = Buffer.from(actual.eventHash(first.prevHash, first));
    const second = auditRow(7n);
    second.prevHash = first.thisHash;
    second.thisHash = Buffer.from(actual.eventHash(second.prevHash, second));
    if (tampered) second.action = 'tampered.action';
    h.prismaOwner.auditLog.findMany.mockResolvedValue([first, second]);

    if (tampered) {
      await expect(run()).rejects.toThrow('AUDIT_ARCHIVE_CHAIN_INVALID');
      expect(h.s3Send).not.toHaveBeenCalled();
      expect(h.prismaOwner.auditArchive.create).not.toHaveBeenCalled();
    } else {
      await expect(run()).resolves.toEqual(ROTATED);
      expect(h.prismaOwner.auditArchive.create).toHaveBeenCalledTimes(1);
    }
  });

  it.each(['content', 'size', 'stream-size'])(
    'registriert bei abweichendem Recovery-Objekt (%s) kein falsches Segment',
    async (mismatch) => {
      const changed = Buffer.from(NDJSON);
      changed[0] = 32;
      const body = Readable.from([
        mismatch === 'content' ? changed : NDJSON,
        ...(mismatch === 'stream-size' ? [Buffer.from('extra')] : []),
      ]);
      h.s3Send.mockImplementation(async (cmd: unknown) =>
        cmd instanceof GetObjectCommand
          ? { ContentLength: NDJSON.length + (mismatch === 'size' ? 1 : 0), Body: body }
          : {},
      );

      await expect(run()).rejects.toThrow('AUDIT_ARCHIVE_RECOVERY_MISMATCH');
      expect(body.destroyed).toBe(true);
      expect(h.prismaOwner.auditArchive.create).not.toHaveBeenCalled();
      expect(sentCommands().some((cmd) => cmd instanceof PutObjectCommand)).toBe(false);
    },
  );
});

describe('F3/F-12: RFC-3161-Stempel und Nachstempel', () => {
  it('wählt die TSA über resolveTsa wie Tagessiegel und Rolling Anchors', async () => {
    await run();

    expect(h.resolveTsa).toHaveBeenCalledWith(TENANT, 'stamp');
    expect(h.tsaTimestamp).toHaveBeenCalledWith(SER.fileSha256);
    expect(h.tsaVerify).toHaveBeenCalledWith(SER.fileSha256, Buffer.from('tsa-stamp'));
    const data = h.prismaOwner.auditArchive.create.mock.calls[0]![0].data as {
      tsaResponseBlob: Uint8Array;
    };
    expect(Buffer.from(data.tsaResponseBlob).toString()).toBe('tsa-stamp');
  });

  it('TSA-Fehlschlag → PENDING ohne Token, Archivierung läuft trotzdem durch', async () => {
    h.tsaTimestamp.mockRejectedValue(new Error('TSA timeout'));

    const result = await run();

    expect(h.prismaOwner.auditArchive.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tsaResponseBlob: null,
        tsaSerial: null,
        tsaStatus: 'PENDING',
        tsaStampedAt: null,
      }),
    });
    expect(result).toEqual(ROTATED);
  });

  it('nicht auflösbare TSA in Produktion (resolveTsa wirft) → PENDING statt Abbruch', async () => {
    h.resolveTsa.mockRejectedValue(new Error('getaddrinfo EAI_AGAIN tsa.example.com'));

    const result = await run();

    expect(h.prismaOwner.auditArchive.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ tsaResponseBlob: null, tsaStatus: 'PENDING' }),
    });
    expect(result).toEqual(ROTATED);
  });

  it('Dev-Self-Timestamp gilt nicht als externer Stempel', async () => {
    h.resolveTsa.mockResolvedValue({
      port: { mode: 'local', timestamp: h.tsaTimestamp, verify: h.tsaVerify },
      url: 'https://tsa.intern.example/tsr',
      source: 'tenant',
    });

    await run();

    expect(h.tsaTimestamp).not.toHaveBeenCalled();
    expect(h.prismaOwner.auditArchive.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ tsaResponseBlob: null, tsaStatus: 'PENDING' }),
    });
  });

  it('untrusted oder an einen anderen Imprint gebundene Antwort wird nicht persistiert', async () => {
    h.tsaVerify.mockResolvedValue(false);

    const result = await run();

    expect(h.tsaVerify).toHaveBeenCalledWith(SER.fileSha256, Buffer.from('tsa-stamp'));
    expect(h.prismaOwner.auditArchive.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ tsaResponseBlob: null, tsaStatus: 'PENDING' }),
    });
    expect(h.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT }),
      expect.stringContaining('TSA-Stempel fehlgeschlagen'),
    );
    expect(result).toEqual(ROTATED);
  });

  describe('Nachstempel von PENDING-Segmenten', () => {
    const PENDING_KEY = `tenants/${TENANT}/audit-archive/2025/12/1-5.ndjson`;
    function pendingSegment(id: bigint, overrides: Record<string, unknown> = {}) {
      return {
        id,
        fromAuditId: id,
        toAuditId: id + 1n,
        storageKey: PENDING_KEY,
        fileSha256: SER.fileSha256,
        fileSizeBytes: BigInt(NDJSON.length),
        firstPrevHash: SER.firstPrevHash,
        lastThisHash: SER.lastThisHash,
        ...overrides,
      };
    }
    function serveStored(body: Buffer = NDJSON) {
      h.s3Send.mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof GetObjectCommand) {
          return { ContentLength: body.length, Body: Readable.from([body]) };
        }
        if (cmd instanceof HeadObjectCommand) throw notFound();
        return {};
      });
    }

    it('prüft das gesperrte Objekt und stempelt PENDING → STAMPED_LATE nach', async () => {
      h.prismaOwner.auditArchive.findMany.mockResolvedValue([pendingSegment(1n)]);
      h.parseArchive.mockReturnValue([{ id: 1n }]);
      serveStored();

      const result = await run();

      expect(h.prismaOwner.auditArchive.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: TENANT, tsaStatus: 'PENDING' },
          orderBy: { fromAuditId: 'asc' },
          take: 100,
        }),
      );
      const get = sentCommands().find((cmd) => cmd instanceof GetObjectCommand) as GetObjectCommand;
      expect(get.input).toEqual({ Bucket: 'gobd-bucket', Key: PENDING_KEY });
      expect(h.parseArchive).toHaveBeenCalledWith(NDJSON);
      expect(h.verifyArchiveChain).toHaveBeenCalledWith([{ id: 1n }], {
        firstPrevHash: SER.firstPrevHash,
        lastThisHash: SER.lastThisHash,
      });
      expect(h.tsaTimestamp).toHaveBeenCalledWith(SER.fileSha256);
      expect(h.prismaOwner.auditArchive.updateMany).toHaveBeenCalledWith({
        where: { id: 1n, tenantId: TENANT, tsaStatus: 'PENDING' },
        data: {
          tsaResponseBlob: expect.any(Uint8Array),
          tsaSerial: '0a1b',
          tsaStatus: 'STAMPED_LATE',
          tsaStampedAt: FIXED_NOW,
        },
      });
      expect(result).toEqual({ ...ROTATED, restamped: 1 });
    });

    it.each([
      ['abweichender Inhalt', Buffer.from('{"id":"9"}\n{"id":"7"}\n'), { ok: true }],
      ['gebrochene Kette', NDJSON, { ok: false, reason: 'lastThisHash mismatch' }],
    ])('stempelt bei %s nicht nach und meldet den Befund', async (_case, body, chain) => {
      h.prismaOwner.auditArchive.findMany.mockResolvedValue([pendingSegment(1n)]);
      serveStored(body);
      h.verifyArchiveChain.mockReturnValueOnce(chain).mockReturnValue({ ok: true });

      const result = await run();

      expect(h.prismaOwner.auditArchive.updateMany).not.toHaveBeenCalled();
      expect(h.log.error).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT, archiveId: '1', storageKey: PENDING_KEY }),
        expect.stringContaining('kein Nachstempel'),
      );
      expect(result).toEqual({ ...ROTATED, restampRejected: 1 });
    });

    it('beendet den Nachstempel beim ersten TSA-Fehler', async () => {
      h.prismaOwner.auditArchive.findMany.mockResolvedValue([
        pendingSegment(1n),
        pendingSegment(3n),
      ]);
      serveStored();
      h.tsaTimestamp.mockRejectedValueOnce(new Error('TSA timeout'));

      const result = await run();

      // ein Versuch für Segment 1, danach nur noch der Stempel des neuen Segments
      expect(h.tsaTimestamp).toHaveBeenCalledTimes(2);
      expect(h.prismaOwner.auditArchive.updateMany).not.toHaveBeenCalled();
      expect(result).toEqual(ROTATED);
    });

    it('P-17: stempelt seitenweise nach, bis kein PENDING-Segment mehr offen ist', async () => {
      const page = Array.from({ length: 100 }, (_, i) => pendingSegment(BigInt(2 * i + 1)));
      h.prismaOwner.auditArchive.findMany
        .mockResolvedValueOnce(page)
        .mockResolvedValueOnce([pendingSegment(201n)]);
      serveStored();

      const result = await run();

      expect(h.prismaOwner.auditArchive.findMany).toHaveBeenCalledTimes(2);
      expect(h.prismaOwner.auditArchive.findMany.mock.calls[1]![0].where).toEqual({
        tenantId: TENANT,
        tsaStatus: 'PENDING',
        fromAuditId: { gt: 199n },
      });
      expect(result).toEqual({ ...ROTATED, restamped: 101 });
    });
  });
});

describe('P-17: Nachlauf bis nichts mehr fällig ist oder das Zeitbudget endet', () => {
  /** Zustandsbehaftete Fakes: `total` fällige Einträge, Archiv wächst mit create(). */
  function dueEntries(total: number, onSegment?: () => void) {
    const archived: Array<{ fromAuditId: bigint; toAuditId: bigint; tsaStatus: string }> = [];
    h.prismaOwner.auditArchive.findFirst.mockImplementation(async () =>
      archived.length ? { toAuditId: archived[archived.length - 1]!.toAuditId } : null,
    );
    h.prismaOwner.auditLog.aggregate.mockResolvedValue({ _max: { id: BigInt(total) } });
    h.prismaOwner.auditLog.findMany.mockImplementation(
      async ({ where, take }: { where: { id: { gt: bigint; lte: bigint } }; take: number }) => {
        const rows = [];
        for (let id = where.id.gt + 1n; id <= where.id.lte && rows.length < take; id++) {
          rows.push(auditRow(id));
        }
        return rows;
      },
    );
    h.prismaOwner.auditLog.count.mockImplementation(
      async ({ where }: { where: { id: { gt: bigint; lte: bigint } } }) =>
        Number(where.id.lte - where.id.gt),
    );
    h.serializeArchive.mockImplementation((rows: Array<{ id: bigint }>) => {
      const from = rows[0]!.id;
      const to = rows[rows.length - 1]!.id;
      const ndjson = Buffer.from(`${from}-${to}`);
      return {
        ...SER,
        fromAuditId: from,
        toAuditId: to,
        entryCount: rows.length,
        ndjson,
        fileSha256: createHash('sha256').update(ndjson).digest(),
      };
    });
    h.prismaOwner.auditArchive.create.mockImplementation(
      async ({ data }: { data: { fromAuditId: bigint; toAuditId: bigint; tsaStatus: string } }) => {
        archived.push(data);
        onSegment?.();
        return {};
      },
    );
    h.prismaOwner.auditArchive.count.mockImplementation(
      async () => archived.filter((segment) => segment.tsaStatus === 'PENDING').length,
    );
    return archived;
  }

  it('archiviert Segment um Segment, bis nichts mehr fällig ist', async () => {
    const archived = dueEntries(12_000);

    const result = await run();

    expect(archived.map((segment) => [segment.fromAuditId, segment.toAuditId])).toEqual([
      [1n, 5000n],
      [5001n, 10000n],
      [10001n, 12000n],
    ]);
    expect(result).toEqual({ ...NOTHING, totalArchived: 12_000, segments: 3 });
    // Ein nicht volles Segment hat den fälligen Bereich vollständig erfasst.
    expect(h.prismaOwner.auditLog.aggregate).toHaveBeenCalledTimes(3);
    expect(h.prismaOwner.auditLog.count).not.toHaveBeenCalled();
  });

  it('endet am Zeitbudget (~10 min) und meldet den Rückstand', async () => {
    // Jedes Segment „dauert" vier Minuten.
    const archived = dueEntries(30_000, () => vi.setSystemTime(Date.now() + 4 * 60_000));

    const result = await run();

    expect(archived).toHaveLength(3);
    expect(result).toEqual({
      ...NOTHING,
      totalArchived: 15_000,
      segments: 3,
      backlog: 15_000,
      budgetExhausted: true,
    });
    expect(h.log.warn).toHaveBeenCalledWith(
      { backlog: 15_000, unfinishedTenants: 1 },
      expect.stringContaining('Zeitbudget erreicht'),
    );
  });

  it('versucht nach gescheitertem Stempel im selben Lauf keinen weiteren und zählt PENDING', async () => {
    const archived = dueEntries(7_000);
    h.tsaTimestamp.mockRejectedValue(new Error('TSA timeout'));

    const result = await run();

    expect(h.tsaTimestamp).toHaveBeenCalledTimes(1);
    expect(archived.map((segment) => segment.tsaStatus)).toEqual(['PENDING', 'PENDING']);
    expect(h.prismaOwner.auditArchive.count).toHaveBeenCalledWith({
      where: { tsaStatus: 'PENDING', tenantId: TENANT },
    });
    expect(result).toEqual({ ...NOTHING, totalArchived: 7_000, segments: 2, pendingStamps: 2 });
  });

  it('hört beim Herunterfahren des Workers vor dem nächsten Schritt auf', async () => {
    const worker = auditRotateWorker as unknown as { closing?: Promise<void> };
    worker.closing = Promise.resolve();
    try {
      h.prismaOwner.auditLog.count.mockResolvedValue(2);

      const result = await run();

      expect(h.s3Send).not.toHaveBeenCalled();
      expect(h.prismaOwner.auditArchive.create).not.toHaveBeenCalled();
      expect(h.prismaOwner.auditLog.count).toHaveBeenCalledWith({
        where: { tenantId: TENANT, id: { gt: 5n, lte: 7n } },
      });
      expect(result).toEqual({ ...NOTHING, backlog: 2, budgetExhausted: true });
    } finally {
      delete worker.closing;
    }
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
      expect(result).toEqual(ROTATED);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
