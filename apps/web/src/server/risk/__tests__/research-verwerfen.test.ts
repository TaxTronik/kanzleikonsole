// Fachkatalog: RISK-ARCHIVE-SNAPSHOT-001
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  evidenceRecord: vi.fn(),
}));

vi.mock('@/server/container', () => ({ evidenceService: { record: mocks.evidenceRecord } }));

import type { TenantContext, TxClient } from '@taxtronik/db';
import { setResearchResultVerworfenTx } from '../research-lifecycle';

const ctx: TenantContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  actorId: '22222222-2222-4222-8222-222222222222',
  actorType: 'STAFF',
};

function mockTx(status: string) {
  const tx = {
    riskResearchResult: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ id: 'r1', title: 'Ergebnis', status, markingId: 'm1' }),
      update: vi.fn(),
    },
    notification: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  return tx;
}

describe('setResearchResultVerworfenTx', () => {
  beforeEach(() => vi.clearAllMocks());

  it('setzt den Status und protokolliert die Pruefentscheidung', async () => {
    const tx = mockTx('NEU');
    await setResearchResultVerworfenTx(tx as unknown as TxClient, ctx, 'r1');

    expect(tx.riskResearchResult.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: { status: 'VERWORFEN' },
    });
    const [, eintrag] = mocks.evidenceRecord.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(eintrag.action).toBe('risk.research.verworfen');
    expect(eintrag.resourceId).toBe('r1');
  });

  it('ist idempotent — ein bereits verworfenes Ergebnis wird nicht erneut geschrieben', async () => {
    const tx = mockTx('VERWORFEN');
    await setResearchResultVerworfenTx(tx as unknown as TxClient, ctx, 'r1');

    expect(tx.riskResearchResult.update).not.toHaveBeenCalled();
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
  });

  it('wirft, wenn das Ergebnis nicht existiert', async () => {
    const tx = mockTx('NEU');
    tx.riskResearchResult.findUnique.mockResolvedValue(null);

    await expect(
      setResearchResultVerworfenTx(tx as unknown as TxClient, ctx, 'weg'),
    ).rejects.toThrow(/nicht gefunden/);
  });
});
