import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  withTenantContext: vi.fn(),
  commitBytesWithTier: vi.fn(),
  createDocumentWithVersion: vi.fn(),
  evidenceRecord: vi.fn(),
}));

vi.mock('@taxtronik/db', () => ({ withTenantContext: mocks.withTenantContext }));
vi.mock('@taxtronik/storage', () => ({
  commitBytesWithTier: mocks.commitBytesWithTier,
}));
vi.mock('@/server/documents/upload-helpers', () => ({
  createDocumentWithVersion: mocks.createDocumentWithVersion,
}));
vi.mock('@/server/container', () => ({
  evidenceService: { record: mocks.evidenceRecord },
}));

import type { TenantContext, TxClient } from '@taxtronik/db';
import { saveResearchResultToShelf } from '../research-shelf';

const ctx: TenantContext = {
  tenantId: '9b0ae933-a240-495d-8957-4ec48e5373f9',
  actorId: '0df6b74a-7b3d-48f0-8240-3f82e795195a',
  actorType: 'STAFF',
};

const input = {
  resultId: '86db52b7-84e4-4169-a127-40872a0a35d5',
  clientId: '796bf676-7e35-4245-8f85-57d0a8de3339',
  analysisId: '7f5fd4a2-9a83-4575-96a0-c1c4aab4e486',
  staffId: '0df6b74a-7b3d-48f0-8240-3f82e795195a',
};

function mockTx() {
  const tx = {
    $queryRaw: vi.fn(),
    client: { findUnique: vi.fn() },
    riskResearchResult: { update: vi.fn() },
  };
  mocks.withTenantContext.mockImplementation(
    (_context: TenantContext, callback: (transaction: TxClient) => Promise<unknown>) =>
      callback(tx as unknown as TxClient),
  );
  return tx;
}

describe('saveResearchResultToShelf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('legt ein Rechercheergebnis genau einmal ab und verknüpft das Dokument', async () => {
    const tx = mockTx();
    tx.$queryRaw.mockResolvedValue([
      {
        id: input.resultId,
        title: 'Ergebnis',
        body: '# Antwort',
        requestTitle: 'Rechercheauftrag',
        shelfDocumentId: null,
      },
    ]);
    tx.client.findUnique.mockResolvedValue({ allowActive: true });
    mocks.commitBytesWithTier.mockResolvedValue({ targetBucket: 'general' });
    mocks.createDocumentWithVersion.mockResolvedValue({
      document: { id: 'f4499c61-327f-4e99-bfab-792ce466cfed' },
      version: { id: 'version-1' },
    });

    await expect(saveResearchResultToShelf(ctx, input)).resolves.toEqual({
      documentId: 'f4499c61-327f-4e99-bfab-792ce466cfed',
      alreadySaved: false,
    });

    const sql = (tx.$queryRaw.mock.calls[0]?.[0] as TemplateStringsArray).join('?');
    expect(sql).toContain('FOR UPDATE OF research_result');
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.commitBytesWithTier.mock.invocationCallOrder[0]!,
    );
    expect(mocks.commitBytesWithTier).toHaveBeenCalledWith({
      fileData: Buffer.from('# Antwort', 'utf8'),
      tier: 'NONE',
      tenantId: ctx.tenantId,
      skipScan: true,
    });
    expect(tx.riskResearchResult.update).toHaveBeenCalledWith({
      where: { id: input.resultId },
      data: {
        shelfDocumentId: 'f4499c61-327f-4e99-bfab-792ce466cfed',
      },
    });
    expect(mocks.evidenceRecord).toHaveBeenCalledTimes(1);
  });

  it('gibt bei einem weiteren Klick das vorhandene Dokument zurück', async () => {
    const tx = mockTx();
    tx.$queryRaw.mockResolvedValue([
      {
        id: input.resultId,
        title: 'Ergebnis',
        body: '# Antwort',
        requestTitle: null,
        shelfDocumentId: 'f4499c61-327f-4e99-bfab-792ce466cfed',
      },
    ]);

    await expect(saveResearchResultToShelf(ctx, input)).resolves.toEqual({
      documentId: 'f4499c61-327f-4e99-bfab-792ce466cfed',
      alreadySaved: true,
    });
    expect(tx.client.findUnique).not.toHaveBeenCalled();
    expect(mocks.commitBytesWithTier).not.toHaveBeenCalled();
    expect(mocks.createDocumentWithVersion).not.toHaveBeenCalled();
    expect(tx.riskResearchResult.update).not.toHaveBeenCalled();
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
  });

  it('kann nach dem Löschen des verknüpften Dokuments erneut abgelegt werden', async () => {
    const tx = mockTx();
    tx.$queryRaw.mockResolvedValue([
      {
        id: input.resultId,
        title: 'Ergebnis',
        body: '# Antwort',
        requestTitle: null,
        shelfDocumentId: null,
      },
    ]);
    tx.client.findUnique.mockResolvedValue({ allowActive: true });
    mocks.commitBytesWithTier.mockResolvedValue({ targetBucket: 'general' });
    mocks.createDocumentWithVersion.mockResolvedValue({
      document: { id: '1e96cdee-f4bc-4da0-8cc3-96f547b55398' },
      version: { id: 'version-2' },
    });

    await expect(saveResearchResultToShelf(ctx, input)).resolves.toEqual({
      documentId: '1e96cdee-f4bc-4da0-8cc3-96f547b55398',
      alreadySaved: false,
    });
    expect(mocks.commitBytesWithTier).toHaveBeenCalledTimes(1);
  });

  it('behält die GwG-Schranke vor der Dokumentanlage bei', async () => {
    const tx = mockTx();
    tx.$queryRaw.mockResolvedValue([
      {
        id: input.resultId,
        title: 'Ergebnis',
        body: '# Antwort',
        requestTitle: null,
        shelfDocumentId: null,
      },
    ]);
    tx.client.findUnique.mockResolvedValue({ allowActive: false });

    await expect(saveResearchResultToShelf(ctx, input)).rejects.toThrow('GwG-Prüfung ausstehend');
    expect(mocks.commitBytesWithTier).not.toHaveBeenCalled();
    expect(mocks.createDocumentWithVersion).not.toHaveBeenCalled();
  });
});
