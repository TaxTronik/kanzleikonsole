import { beforeEach, describe, expect, it, vi } from 'vitest';

const { record } = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock('@/server/container', () => ({ evidenceService: { record } }));

import type { TxClient } from '@taxtronik/db';

import { assertBwaBasePeriodForClientTx, createBwaPlanTx, uniqueBwaPlanLines } from '../plans';

function mockTx() {
  const tx = {
    bwaPeriod: { findFirst: vi.fn() },
    bwaPlan: { create: vi.fn() },
  };
  return tx as unknown as TxClient & typeof tx;
}

describe('BWA plan domain service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps only the first line for each axis', () => {
    expect(
      uniqueBwaPlanLines([
        { axis: 'REVENUE', amount: 10 },
        { axis: 'REVENUE', amount: 20 },
        { axis: 'TAXES', amount: 5 },
      ]),
    ).toEqual([
      { axis: 'REVENUE', amount: 10 },
      { axis: 'TAXES', amount: 5 },
    ]);
  });

  it('rejects a base period that does not belong to the selected client', async () => {
    const tx = mockTx();
    tx.bwaPeriod.findFirst.mockResolvedValue(null);

    await expect(assertBwaBasePeriodForClientTx(tx, 'client-a', 'period-b')).rejects.toThrow(
      'BWA-Periode nicht gefunden.',
    );
    expect(tx.bwaPeriod.findFirst).toHaveBeenCalledWith({
      where: { id: 'period-b', clientId: 'client-a' },
      select: { id: true },
    });
  });

  it('applies the same base-period guard before a staff or portal create', async () => {
    const tx = mockTx();
    tx.bwaPeriod.findFirst.mockResolvedValue(null);

    await expect(
      createBwaPlanTx(tx, {
        tenantId: 'tenant',
        clientId: 'client-a',
        actor: { id: 'actor', type: 'STAFF' },
        data: {
          name: 'Plan',
          year: 2026,
          basePeriodId: 'period-b',
          status: 'FINAL',
          lines: [],
        },
      }),
    ).rejects.toThrow('BWA-Periode nicht gefunden.');
    expect(tx.bwaPlan.create).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});
