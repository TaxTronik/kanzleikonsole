// =============================================================================
// Unit-Tests: poa-expiry-check-Worker (Ablauf signierter Vollmachten).
// Fachkatalog: POA-LIFECYCLE-001
//
// bullmq via mocks/bullmq.ts, Prisma/Notify/Tenant-Context/Evidence per
// vi.mock. Abgedeckt:
//   - Schwellenlogik: > 30 Tage nichts, ≤ 30 Tage POA_EXPIRY_SOON,
//     daysLeft < 0 → EXPIRED (validUntil bleibt inklusive gültig)
//   - RF-8: Statuswechsel SIGNED → EXPIRED + Audit-Record 'poa.expire' laufen
//     in EINER Tenant-Context-Tx (guarded updateMany auf status SIGNED)
//   - Idempotenz: updateMany count 0 → kein Audit-Record und keine Notification
//   - Empfänger: Responsibilities des Mandanten, sonst ADMIN/PARTNER-Fallback
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => {
  const prismaOwner = {
    tenant: { findMany: vi.fn() },
    staffUser: { findMany: vi.fn() },
    powerOfAttorney: { findMany: vi.fn() },
  };
  const tx = {
    $queryRaw: vi.fn(),
    powerOfAttorney: { findFirst: vi.fn(), updateMany: vi.fn() },
    staffUser: prismaOwner.staffUser,
  };
  const withWorkerTenantContext = vi.fn(
    async (_tenantId: string, fn: (t: unknown) => Promise<unknown>) => fn(tx),
  );
  const record = vi.fn();
  const upsertNotification = vi.fn();
  const resolveNotificationsTx = vi.fn();
  return {
    prismaOwner,
    tx,
    withWorkerTenantContext,
    record,
    upsertNotification,
    resolveNotificationsTx,
  };
});

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../prisma-owner', () => ({ prismaOwner: h.prismaOwner }));
vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../tenant-context', () => ({ withWorkerTenantContext: h.withWorkerTenantContext }));
vi.mock('@taxtronik/db/notification', () => ({
  resolveNotificationsTx: h.resolveNotificationsTx,
  upsertNotificationTx: h.upsertNotification,
}));
vi.mock('@taxtronik/db/staff-client-access', () => ({
  filterStaffAccessClientTx: async (_tx: unknown, _tenant: string, ids: string[]) => new Set(ids),
}));
vi.mock('@taxtronik/evidence', () => ({
  EvidenceService: class {
    record = h.record;
  },
  LocalTimestampAdapter: class {},
}));

import { processors } from './mocks/bullmq';
import '../poa-expiry-check';

const FIXED_NOW = new Date('2026-06-09T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const TENANT = 'tenant-1';

interface PoaResult {
  soon: number;
  expired: number;
}

function run(): Promise<PoaResult> {
  return processors.get('poa-expiry-check')!({ data: { tenantId: TENANT } }) as Promise<PoaResult>;
}

function poa(validUntil: Date, overrides: Record<string, unknown> = {}) {
  return {
    id: 'poa-1',
    clientId: 'client-1',
    subject: 'Steuerliche Vertretung',
    signerName: 'Max Muster',
    status: 'SIGNED',
    validUntil,
    client: {
      name: 'Muster GmbH',
      responsibilities: [{ staffId: 'hb-1' }],
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  vi.resetAllMocks();
  h.withWorkerTenantContext.mockImplementation(
    async (_tenantId: string, fn: (t: unknown) => Promise<unknown>) => fn(h.tx),
  );
  h.prismaOwner.tenant.findMany.mockResolvedValue([{ id: TENANT }]);
  h.prismaOwner.staffUser.findMany.mockResolvedValue([{ id: 'admin-1' }]);
  h.prismaOwner.powerOfAttorney.findMany.mockResolvedValue([]);
  h.tx.powerOfAttorney.updateMany.mockResolvedValue({ count: 1 });
  h.tx.$queryRaw.mockResolvedValue([{ id: 'poa-1' }]);
  h.tx.powerOfAttorney.findFirst.mockImplementation(
    async () =>
      (await h.prismaOwner.powerOfAttorney.findMany.mock.results.at(-1)?.value)?.[0] ?? null,
  );
  h.record.mockResolvedValue({});
  h.upsertNotification.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Schwellenlogik', () => {
  it('RF-14: nur SIGNED-Vollmachten im 30-Tage-Relevanz-Fenster werden geladen', async () => {
    await run();

    expect(h.prismaOwner.powerOfAttorney.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: TENANT,
          status: 'SIGNED',
          validUntil: { not: null, lte: new Date(FIXED_NOW.getTime() + 30 * DAY) },
        },
      }),
    );
  });

  it('> 30 Tage Restlaufzeit → weder Notification noch Statuswechsel', async () => {
    h.prismaOwner.powerOfAttorney.findMany.mockResolvedValue([
      poa(new Date(FIXED_NOW.getTime() + 31 * DAY)),
    ]);

    const result = await run();

    expect(h.upsertNotification).not.toHaveBeenCalled();
    expect(h.tx.powerOfAttorney.updateMany).not.toHaveBeenCalled();
    expect(result).toEqual({ soon: 0, expired: 0 });
  });

  it('genau 30 Tage → POA_EXPIRY_SOON an den Bearbeiter, KEIN Statuswechsel', async () => {
    h.prismaOwner.powerOfAttorney.findMany.mockResolvedValue([
      poa(new Date(FIXED_NOW.getTime() + 30 * DAY)),
    ]);

    const result = await run();

    expect(h.withWorkerTenantContext).toHaveBeenCalledOnce();
    expect(h.record).not.toHaveBeenCalled();
    expect(h.upsertNotification).toHaveBeenCalledTimes(1);
    expect(h.upsertNotification).toHaveBeenCalledWith(
      h.tx,
      expect.objectContaining({
        tenantId: TENANT,
        staffId: 'hb-1',
        kind: 'POA_EXPIRY_SOON',
        title: 'Vollmacht läuft in 30 Tagen ab — Muster GmbH',
        href: '/staff/poa/poa-1',
        resourceType: 'power_of_attorney',
        resourceId: 'poa-1',
      }),
    );
    expect(result).toEqual({ soon: 1, expired: 0 });
  });
});

describe('RF-8: Ablauf — Statuswechsel + Audit-Record in einer Tx', () => {
  it('validUntil == heute (Datum) gilt INKLUSIVE → NICHT abgelaufen, nur „läuft heute ab"', async () => {
    // validUntil ist @db.Date (UTC-Mitternacht). Am validUntil-Tag ist die
    // Vollmacht noch gültig — sie läuft erst am Folgetag ab. Kein Statuswechsel.
    const validUntil = new Date('2026-06-09T00:00:00.000Z');
    h.prismaOwner.powerOfAttorney.findMany.mockResolvedValue([poa(validUntil)]);

    const result = await run();

    expect(h.withWorkerTenantContext).toHaveBeenCalledOnce();
    expect(h.record).not.toHaveBeenCalled();
    expect(h.upsertNotification).toHaveBeenCalledWith(
      h.tx,
      expect.objectContaining({
        tenantId: TENANT,
        staffId: 'hb-1',
        kind: 'POA_EXPIRY_SOON',
        title: 'Vollmacht läuft heute ab — Muster GmbH',
      }),
    );
    expect(result).toEqual({ soon: 1, expired: 0 });
  });

  it('validUntil == gestern (Datum) → abgelaufen: guarded updateMany + poa.expire im selben Tx', async () => {
    const validUntil = new Date('2026-06-08T00:00:00.000Z');
    h.prismaOwner.powerOfAttorney.findMany.mockResolvedValue([poa(validUntil)]);

    const result = await run();

    expect(h.withWorkerTenantContext).toHaveBeenCalledTimes(1);
    expect(h.withWorkerTenantContext.mock.calls[0]![0]).toBe(TENANT);
    // Guarded: nur SIGNED → EXPIRED (paralleler Lauf darf nicht doppelt schreiben)
    expect(h.tx.powerOfAttorney.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'poa-1',
        tenantId: TENANT,
        status: 'SIGNED',
        validUntil: { lt: new Date('2026-06-09T00:00:00Z') },
      },
      data: { status: 'EXPIRED' },
    });
    // Audit-Record läuft auf DEMSELBEN Tx-Client wie der Statuswechsel
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.record.mock.calls[0]![0]).toBe(h.tx);
    expect(h.record.mock.calls[0]![1]).toEqual({
      tenantId: TENANT,
      actorType: 'SYSTEM',
      actorId: null,
      action: 'poa.expire',
      resourceType: 'power_of_attorney',
      resourceId: 'poa-1',
      before: { status: 'SIGNED' },
      after: { status: 'EXPIRED', validUntil },
    });
    expect(h.upsertNotification).toHaveBeenCalledWith(
      h.tx,
      expect.objectContaining({
        tenantId: TENANT,
        staffId: 'hb-1',
        kind: 'POA_EXPIRED',
        title: 'Vollmacht abgelaufen — Muster GmbH',
      }),
    );
    expect(result).toEqual({ soon: 0, expired: 1 });
  });

  it('verlorener Status-Claim → kein Audit-Record und keine veraltete Notification', async () => {
    h.prismaOwner.powerOfAttorney.findMany.mockResolvedValue([
      poa(new Date(FIXED_NOW.getTime() - 5 * DAY)),
    ]);
    h.tx.powerOfAttorney.updateMany.mockResolvedValue({ count: 0 });

    await run();

    expect(h.record).not.toHaveBeenCalled();
    expect(h.upsertNotification).not.toHaveBeenCalled();
  });
});

describe('Empfänger', () => {
  it('ohne Responsibilities → ADMIN/PARTNER-Fallback', async () => {
    h.prismaOwner.powerOfAttorney.findMany.mockResolvedValue([
      poa(new Date(FIXED_NOW.getTime() + 10 * DAY), {
        client: { name: 'Muster GmbH', responsibilities: [] },
      }),
    ]);

    await run();

    expect(h.upsertNotification).toHaveBeenCalledTimes(1);
    expect(h.upsertNotification.mock.calls[0]![1].staffId).toBe('admin-1');
  });

  it('gar keine Empfänger → Ablaufstatus und Evidence bleiben unabhängig von der Zustellung', async () => {
    h.prismaOwner.staffUser.findMany.mockResolvedValue([]);
    h.prismaOwner.powerOfAttorney.findMany.mockResolvedValue([
      poa(new Date(FIXED_NOW.getTime() - DAY), {
        client: { name: 'Muster GmbH', responsibilities: [] },
      }),
    ]);

    const result = await run();

    expect(h.withWorkerTenantContext).toHaveBeenCalledOnce();
    expect(h.tx.powerOfAttorney.updateMany).toHaveBeenCalledOnce();
    expect(h.record).toHaveBeenCalledOnce();
    expect(h.upsertNotification).not.toHaveBeenCalled();
    expect(result).toEqual({ soon: 0, expired: 0 });
  });
});
