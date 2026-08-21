// =============================================================================
// Unit-Tests: evidence-seal-Worker (RF-2 Backfill verpasster Versiegelungstage).
//
// bullmq wird durch mocks/bullmq.ts ersetzt (fängt den Processor beim
// Modul-Load ab), Prisma/Evidence/SSRF-Guard per vi.mock — kein Redis, keine
// DB. Abgedeckt:
//   - Backfill füllt GENAU die unversiegelten Tage seit dem letzten Seal
//     (Start: ältestes Audit-Event NACH dem Seal-Tag) bis einschließlich
//     gestern (UTC)
//   - idempotent: ohne neue Audit-Events wird nichts erneut versiegelt
//   - harte Obergrenze MAX_BACKFILL_DAYS = 366 pro Lauf
//   - Manual-Trigger mit sealDate versiegelt exakt diesen Tag
//   - Fehler eines Tenants stoppen die übrigen Tenants nicht
//   - F1/TOCTOU: TSA-URL nicht öffentlich auflösbar → LocalTimestamp-Fallback
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => {
  const sealDay = vi.fn();
  const constructedPorts: unknown[] = [];
  const prismaOwner = {
    tenant: { findMany: vi.fn() },
    tenantSetting: { findUnique: vi.fn() },
    auditLog: { aggregate: vi.fn() },
    $queryRaw: vi.fn(),
  };
  const assertPublicHost = vi.fn();
  return { sealDay, constructedPorts, prismaOwner, assertPublicHost };
});

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../prisma-owner', () => ({ prismaOwner: h.prismaOwner }));
vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../http/ssrf-guard', () => ({ assertPublicHost: h.assertPublicHost }));
vi.mock('@taxtronik/config', () => ({ env: {} }));
vi.mock('@taxtronik/evidence', () => {
  class LocalTimestampAdapter {}
  class Rfc3161HttpAdapter {
    constructor(public url: string) {}
  }
  class EvidenceService {
    sealDay = h.sealDay;
    constructor(port: unknown) {
      h.constructedPorts.push(port);
    }
  }
  return {
    EvidenceService,
    LocalTimestampAdapter,
    Rfc3161HttpAdapter,
    createRfc3161Adapter: (url: string) => new Rfc3161HttpAdapter(url),
    resolveTsaUrl: (providerId: string | null, customUrl: string | null) =>
      customUrl ?? (providerId ? `https://tsa.example.com/${providerId}` : null),
  };
});

import { LocalTimestampAdapter, Rfc3161HttpAdapter } from '@taxtronik/evidence';
import { processors } from './mocks/bullmq';
import '../evidence-seal';

const FIXED_NOW = new Date('2026-06-09T10:00:00.000Z'); // gestern (UTC) = 08.06.
const TENANT = 'tenant-a';

interface SealResult {
  sealed: Array<{ tenantId: string; sealed: boolean; reason?: string }>;
}

function run(data: { tenantId?: string; sealDate?: string } = {}): Promise<SealResult> {
  return processors.get('evidence-seal')!({ data }) as Promise<SealResult>;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function sealedDays(): string[] {
  return h.sealDay.mock.calls.map((c) => ymd(c[2] as Date));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  vi.resetAllMocks();
  h.constructedPorts.length = 0;
  h.prismaOwner.tenant.findMany.mockResolvedValue([{ id: TENANT }]);
  h.prismaOwner.tenantSetting.findUnique.mockResolvedValue(null);
  h.assertPublicHost.mockResolvedValue(undefined);
  h.sealDay.mockResolvedValue({ sealed: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Backfill — verpasste Versiegelungstage', () => {
  it('füllt genau die unversiegelten Tage seit dem letzten Seal bis gestern (UTC)', async () => {
    // Letzter Seal: 05.06. — Worker war danach 3 Tage down.
    h.prismaOwner.$queryRaw.mockResolvedValue([{ max: '2026-06-05' }]);
    h.prismaOwner.auditLog.aggregate.mockResolvedValue({
      _min: { occurredAt: new Date('2026-06-06T08:30:00.000Z') },
    });

    await run({ tenantId: TENANT });

    expect(sealedDays()).toEqual(['2026-06-06', '2026-06-07', '2026-06-08']);
    // Startpunkt-Query: ältestes Audit-Event NACH dem letzten Seal-Tag
    expect(h.prismaOwner.auditLog.aggregate).toHaveBeenCalledWith({
      _min: { occurredAt: true },
      where: { tenantId: TENANT, occurredAt: { gte: new Date('2026-06-06T00:00:00.000Z') } },
    });
    // RF-4: sealDay läuft direkt auf dem Owner-Client (keine umschließende TX)
    expect(h.sealDay.mock.calls[0]![0]).toBe(h.prismaOwner);
    expect(h.sealDay.mock.calls[0]![1]).toBe(TENANT);
  });

  it('ist idempotent: alles bis gestern versiegelt + keine neuen Events → kein sealDay', async () => {
    h.prismaOwner.$queryRaw.mockResolvedValue([{ max: '2026-06-08' }]);
    h.prismaOwner.auditLog.aggregate.mockResolvedValue({ _min: { occurredAt: null } });

    const result = await run({ tenantId: TENANT });

    expect(h.sealDay).not.toHaveBeenCalled();
    expect(result.sealed).toEqual([]);
    // Tenant wird komplett übersprungen — nicht mal die TSA-Config wird gelesen
    expect(h.prismaOwner.tenantSetting.findUnique).not.toHaveBeenCalled();
  });

  it('noch nie versiegelt → Start am Tag des ältesten Audit-Events', async () => {
    h.prismaOwner.$queryRaw.mockResolvedValue([{ max: null }]);
    h.prismaOwner.auditLog.aggregate.mockResolvedValue({
      _min: { occurredAt: new Date('2026-06-07T23:59:59.000Z') },
    });

    await run({ tenantId: TENANT });

    expect(sealedDays()).toEqual(['2026-06-07', '2026-06-08']);
    // Ohne letzten Seal: kein occurredAt-Filter
    expect(h.prismaOwner.auditLog.aggregate).toHaveBeenCalledWith({
      _min: { occurredAt: true },
      where: { tenantId: TENANT },
    });
  });

  it('Events erst heute → heutiger Tag wird nie vorab versiegelt', async () => {
    h.prismaOwner.$queryRaw.mockResolvedValue([{ max: null }]);
    h.prismaOwner.auditLog.aggregate.mockResolvedValue({
      _min: { occurredAt: new Date('2026-06-09T01:00:00.000Z') },
    });

    await run({ tenantId: TENANT });

    expect(h.sealDay).not.toHaveBeenCalled();
  });

  it('RF-2: Backfill ist auf 366 Tage pro Lauf gekappt (Rest folgt beim nächsten Lauf)', async () => {
    h.prismaOwner.$queryRaw.mockResolvedValue([{ max: null }]);
    h.prismaOwner.auditLog.aggregate.mockResolvedValue({
      _min: { occurredAt: new Date('2024-01-01T05:00:00.000Z') }, // > 2 Jahre Backlog
    });

    await run({ tenantId: TENANT });

    expect(h.sealDay).toHaveBeenCalledTimes(366);
    const days = sealedDays();
    expect(days[0]).toBe('2024-01-01');
    expect(days[365]).toBe('2024-12-31'); // 2024 ist Schaltjahr
  });
});

describe('Manual-Trigger', () => {
  it('explizites sealDate versiegelt exakt diesen Tag, kein Backfill-Scan', async () => {
    await run({ tenantId: TENANT, sealDate: '2026-06-01T00:00:00.000Z' });

    expect(sealedDays()).toEqual(['2026-06-01']);
    expect(h.prismaOwner.$queryRaw).not.toHaveBeenCalled();
    expect(h.prismaOwner.auditLog.aggregate).not.toHaveBeenCalled();
  });
});

describe('Fehler-Isolation über Tenants', () => {
  it('Fehler bei Tenant A stoppt Tenant B nicht; reason wird festgehalten', async () => {
    h.prismaOwner.tenant.findMany.mockResolvedValue([{ id: 'tenant-a' }, { id: 'tenant-b' }]);
    h.prismaOwner.$queryRaw.mockResolvedValue([{ max: '2026-06-07' }]);
    h.prismaOwner.auditLog.aggregate.mockResolvedValue({
      _min: { occurredAt: new Date('2026-06-08T01:00:00.000Z') },
    });
    h.sealDay.mockRejectedValueOnce(new Error('TSA down')).mockResolvedValue({ sealed: true });

    const result = await run({});

    expect(result.sealed).toEqual([
      { tenantId: 'tenant-a', sealed: false, reason: 'TSA down' },
      { tenantId: 'tenant-b', sealed: true },
    ]);
  });
});

describe('TSA-Auswahl (F1: TOCTOU-Re-Check)', () => {
  beforeEach(() => {
    // genau ein offener Tag, damit timestampPortFor überhaupt läuft
    h.prismaOwner.$queryRaw.mockResolvedValue([{ max: '2026-06-07' }]);
    h.prismaOwner.auditLog.aggregate.mockResolvedValue({
      _min: { occurredAt: new Date('2026-06-08T01:00:00.000Z') },
    });
  });

  it('öffentlich auflösbare Tenant-TSA → Rfc3161HttpAdapter mit der konfigurierten URL', async () => {
    h.prismaOwner.tenantSetting.findUnique.mockResolvedValue({
      value: { customUrl: 'https://tsa.example.com/tsr' },
    });

    await run({ tenantId: TENANT });

    expect(h.assertPublicHost).toHaveBeenCalledWith('https://tsa.example.com/tsr');
    expect(h.constructedPorts[0]).toBeInstanceOf(Rfc3161HttpAdapter);
    expect((h.constructedPorts[0] as { url: string }).url).toBe('https://tsa.example.com/tsr');
  });

  it('TSA-URL nicht öffentlich auflösbar → Fallback auf LocalTimestampAdapter', async () => {
    h.prismaOwner.tenantSetting.findUnique.mockResolvedValue({
      value: { customUrl: 'https://tsa.intern.example/tsr' },
    });
    h.assertPublicHost.mockRejectedValue(new Error('resolves to private IP'));

    await run({ tenantId: TENANT });

    expect(h.constructedPorts[0]).toBeInstanceOf(LocalTimestampAdapter);
    // versiegelt wird trotzdem — nur eben mit Self-Timestamp
    expect(sealedDays()).toEqual(['2026-06-08']);
  });
});
