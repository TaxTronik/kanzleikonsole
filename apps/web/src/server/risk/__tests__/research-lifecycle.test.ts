import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  withTenantContext: vi.fn(),
  evidenceRecord: vi.fn(),
}));

vi.mock('@taxtronik/db', () => ({ withTenantContext: mocks.withTenantContext }));
vi.mock('@/server/container', () => ({
  evidenceService: { record: mocks.evidenceRecord },
}));

import type { TenantContext, TxClient } from '@taxtronik/db';
import { deleteResearchResult, setResearchResultArchived } from '../research-lifecycle';

const ctx: TenantContext = {
  tenantId: '9b0ae933-a240-495d-8957-4ec48e5373f9',
  actorId: '0df6b74a-7b3d-48f0-8240-3f82e795195a',
  actorType: 'STAFF',
};
const resultId = '86db52b7-84e4-4169-a127-40872a0a35d5';

function mockTx() {
  const tx = {
    riskResearchResult: {
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    notification: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  mocks.withTenantContext.mockImplementation(
    (_context: TenantContext, callback: (transaction: TxClient) => Promise<unknown>) =>
      callback(tx as unknown as TxClient),
  );
  return tx;
}

describe('Rechercheergebnis-Lebenszyklus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('archiviert ein Ergebnis reversibel und protokolliert den Vorgang', async () => {
    const tx = mockTx();
    tx.riskResearchResult.findUnique.mockResolvedValue({
      id: resultId,
      title: 'Recherche',
      archivedAt: null,
      researchRequestId: 'request-1',
    });

    await setResearchResultArchived(ctx, resultId, true);

    expect(tx.riskResearchResult.update).toHaveBeenCalledWith({
      where: { id: resultId },
      data: { archivedAt: expect.any(Date) },
    });
    expect(mocks.evidenceRecord).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'risk.research.archived', resourceId: resultId }),
    );
  });

  it('holt ein archiviertes Ergebnis zurück, ohne seine Zuordnung zu verändern', async () => {
    const tx = mockTx();
    tx.riskResearchResult.findUnique.mockResolvedValue({
      id: resultId,
      title: 'Recherche',
      archivedAt: new Date('2026-07-17T10:00:00.000Z'),
      researchRequestId: 'request-1',
    });

    await setResearchResultArchived(ctx, resultId, false);

    expect(tx.riskResearchResult.update).toHaveBeenCalledWith({
      where: { id: resultId },
      data: { archivedAt: null },
    });
    expect(mocks.evidenceRecord).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'risk.research.restored' }),
    );
  });

  it('löscht nur das Rechercheergebnis und lässt das Aktenregal-Dokument unberührt', async () => {
    const tx = mockTx();
    tx.riskResearchResult.findUnique.mockResolvedValue({
      id: resultId,
      title: 'Recherche',
      status: 'NEU',
      archivedAt: null,
      researchRequestId: 'request-1',
      markingId: null,
      shelfDocumentId: 'document-1',
    });

    await deleteResearchResult(ctx, resultId);

    expect(tx.riskResearchResult.delete).toHaveBeenCalledWith({ where: { id: resultId } });
    expect(mocks.evidenceRecord).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'risk.research.deleted',
        before: expect.objectContaining({ shelfDocumentId: 'document-1' }),
      }),
    );
  });
});
