// =============================================================================
// Unit-Tests: poa-expiry-check-Worker (Ablauf signierter Vollmachten).
//
// bullmq via mocks/bullmq.ts, Prisma/Notify/Tenant-Context/Evidence per
// vi.mock. Abgedeckt:
//   - Schwellenlogik: > 30 Tage nichts, ≤ 30 Tage POA_EXPIRY_SOON,
//     daysLeft ≤ 0 → EXPIRED (Tagesgrenze: validUntil == now zählt als abgelaufen)
//   - RF-8: Statuswechsel SIGNED → EXPIRED + Audit-Record 'poa.expire' laufen
//     in EINER Tenant-Context-Tx (guarded updateMany auf status SIGNED)
//   - Idempotenz: updateMany count 0 → kein Audit-Record, Notification trotzdem
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
    powerOfAttorney: { updateMany: vi.fn() },
  };
  const withWorkerTenantContext = vi.fn(
    async (_tenantId: string, fn: (t: unknown) => Promise<unknown>) => fn(tx),
  );
  const record = vi.fn();
  const upsertNotification = vi.fn();
  return { prismaOwner, tx, withWorkerTenantContext, record, upsertNotification };
});

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../prisma-owner', () => ({ prismaOwner: h.prismaOwner }));
vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../tenant-context', () => ({ withWorkerTenantContext: h.withWorkerTenantContext }));
vi.mock('../../notify', () => ({ upsertNotification: h.upsertNotification }));
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
  h.record.mockResolvedValue({});
  h.upsertNotification.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Schwellenlogik', () => {
  it('nur SIGNED-Vollmachten mit validUntil werden überhaupt geladen', async () => {
    await run();

    expect(h.prismaOwner.powerOfAttorney.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: TENANT, status: 'SIGNED', validUntil: { not: null } },
      }),
    );
  });

  it('> 30 Tage Restlaufzeit → weder Notification noch Statuswechsel', async () => {
    h.prismaOwner.powerOfAttorney.findMany.mockResolvedValue([
      poa(new Date(FIXED_NOW.getTime() + 31 * DAY)),
    ]);

    const result = await run();

    expect(h.upsertNotification).not.toHaveBeenCalled();
    expect(h.withWorkerTenantContext).not.toHaveBeenCalled();
    expect(result).toEqual({ soon: 0, expired: 0 });
  });

  it('genau 30 Tage → POA_EXPIRY_SOON an den Bearbeiter, KEIN Statuswechsel', async () => {
    h.prismaOwner.powerOfAttorney.findMany.mockResolvedValue([
      poa(new Date(FIXED_NOW.getTime() + 30 * DAY)),
    ]);

    const result = await run();

    expect(h.withWorkerTenantContext).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
    expect(h.upsertNotification).toHaveBeenCalledTimes(1);
    expect(h.upsertNotification).toHaveBeenCalledWith(
      TENANT,
      'hb-1',
      expect.objectContaining({
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
  it('validUntil == now zählt als abgelaufen: guarded updateMany + poa.expire im selben Tx', async () => {
    const validUntil = new Date(FIXED_NOW);
    h.prismaOwner.powerOfAttorney.findMany.mockResolvedValue([poa(validUntil)]);

    const result = await run();

    expect(h.withWorkerTenantContext).toHaveBeenCalledTimes(1);
    expect(h.withWorkerTenantContext.mock.calls[0]![0]).toBe(TENANT);
    // Guarded: nur SIGNED → EXPIRED (paralleler Lauf darf nicht doppelt schreiben)
    expect(h.tx.powerOfAttorney.updateMany).toHaveBeenCalledWith({
      where: { id: 'poa-1', status: 'SIGNED' },
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
      TENANT,
      'hb-1',
      expect.objectContaining({
        kind: 'POA_EXPIRED',
        title: 'Vollmacht abgelaufen — Muster GmbH',
      }),
    );
    expect(result).toEqual({ soon: 0, expired: 1 });
  });

  it('idempotent: updateMany count 0 (schon EXPIRED) → kein Audit-Record, Notification trotzdem', async () => {
    h.prismaOwner.powerOfAttorney.findMany.mockResolvedValue([
      poa(new Date(FIXED_NOW.getTime() - 5 * DAY)),
    ]);
    h.tx.powerOfAttorney.updateMany.mockResolvedValue({ count: 0 });

    await run();

    expect(h.record).not.toHaveBeenCalled();
    expect(h.upsertNotification).toHaveBeenCalledWith(
      TENANT,
      'hb-1',
      expect.objectContaining({ kind: 'POA_EXPIRED' }),
    );
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
    expect(h.upsertNotification.mock.calls[0]![1]).toBe('admin-1');
  });

  it('gar keine Empfänger → Vollmacht wird übersprungen (auch kein Statuswechsel)', async () => {
    // Dokumentiert aktuelles Verhalten: der Empfänger-Check kommt VOR dem
    // Statuswechsel — eine abgelaufene POA ohne Empfänger bleibt SIGNED.
    h.prismaOwner.staffUser.findMany.mockResolvedValue([]);
    h.prismaOwner.powerOfAttorney.findMany.mockResolvedValue([
      poa(new Date(FIXED_NOW.getTime() - 1 * DAY), {
        client: { name: 'Muster GmbH', responsibilities: [] },
      }),
    ]);

    const result = await run();

    expect(h.withWorkerTenantContext).not.toHaveBeenCalled();
    expect(h.upsertNotification).not.toHaveBeenCalled();
    expect(result).toEqual({ soon: 0, expired: 0 });
  });
});
