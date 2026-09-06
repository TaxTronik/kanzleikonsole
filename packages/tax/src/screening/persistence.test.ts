// Fachkatalog: GWG-SCREENING-001
import { describe, it, expect, vi } from 'vitest';
import { storeSanctionsSnapshot, followupSanctions } from './persistence';
import type { Prisma } from '@prisma/client';
import type { SanctionEntry } from './core';
const entry: SanctionEntry = {
  id: '13',
  euReference: 'EU.27.28',
  type: 'person',
  names: [{ name: 'Jose Muller', strong: true }],
  birthDates: [],
  countries: [],
  regulations: [],
};
const data = {
  sha256: 'a'.repeat(64),
  sourceUrl: 'https://webgate.ec.europa.eu/',
  sourceVersion: 'one',
  publishedAt: new Date('2026-08-05'),
  entries: [entry],
};
const mock = () => ({
  $executeRaw: vi.fn().mockResolvedValue(1),
  sanctionsSourceState: {
    findUnique: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue({}),
  },
  sanctionsSnapshot: {
    findUnique: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({ id: 'snapshot', ...data, entryCount: 1 }),
  },
  screeningRun: {
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockImplementation(async ({ data }) => ({ id: 'new-run', ...data })),
  },
});
describe('GWG-SCREENING-001: source replacement and immutable follow-ups', () => {
  it('keeps existing dataset and freshness state unchanged when rollback/shrink rejected', async () => {
    const tx = mock();
    tx.sanctionsSourceState.findUnique.mockResolvedValue({
      snapshotId: 'old',
      snapshot: { entryCount: 100, publishedAt: new Date('2026-08-06') },
    });
    await expect(
      storeSanctionsSnapshot(tx as unknown as Prisma.TransactionClient, 'tenant', data),
    ).rejects.toThrow('älter');
    expect(tx.sanctionsSnapshot.create).not.toHaveBeenCalled();
    expect(tx.sanctionsSourceState.upsert).not.toHaveBeenCalled();
  });
  it('refreshes successful check time without duplicating an unchanged snapshot', async () => {
    const tx = mock();
    tx.sanctionsSourceState.findUnique.mockResolvedValue({
      snapshotId: 'snapshot',
      snapshot: { entryCount: 1, publishedAt: data.publishedAt },
    });
    tx.sanctionsSnapshot.findUnique.mockResolvedValue({ id: 'snapshot', ...data });
    const saved = await storeSanctionsSnapshot(
      tx as unknown as Prisma.TransactionClient,
      'tenant',
      data,
    );
    expect(saved.changed).toBe(false);
    expect(tx.sanctionsSnapshot.create).not.toHaveBeenCalled();
    expect(tx.sanctionsSourceState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          snapshotId: 'snapshot',
          lastError: null,
          checkedAt: expect.any(Date),
        }),
      }),
    );
  });
  it('does not repeat completed follow-ups; creates a separate run, never a GwG update', async () => {
    const tx = mock();
    tx.screeningRun.findMany.mockResolvedValue([
      {
        id: 'root1',
        clientId: 'client',
        snapshotId: 'old',
        subject: { name: 'Jose Muller', role: 'Mandant' },
      },
      {
        id: 'root2',
        clientId: 'client',
        snapshotId: 'old',
        subject: { name: 'Other Person', role: 'Mandant' },
      },
    ]);
    tx.screeningRun.findUnique
      .mockResolvedValueOnce({ id: 'existing' })
      .mockResolvedValueOnce(null);
    const result = await followupSanctions(
      tx as unknown as Prisma.TransactionClient,
      'tenant',
      'new',
      [entry],
    );
    expect(tx.screeningRun.create).toHaveBeenCalledTimes(1);
    expect(tx.screeningRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant',
        previousRunId: 'root2',
        snapshotId: 'new',
        createdBy: null,
      }),
    });
    expect(result.created).toEqual([{ id: 'new-run', clientId: 'client', candidates: false }]);
    expect(tx.screeningRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant',
          client: { mandateEndedAt: null, anonymizedAt: null },
        }),
      }),
    );
  });
});
