// Fachkatalog: DOC-UPLOAD-JOURNAL-001
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  withTenantContext: vi.fn(),
  prepare: vi.fn(),
  createDocumentWithVersion: vi.fn(),
  evidenceRecord: vi.fn(),
}));

vi.mock('@taxtronik/db', () => ({ withTenantContext: mocks.withTenantContext }));
vi.mock('@taxtronik/storage', async () => {
  const { storageJournal } = await import('@/server/documents/__tests__/storage-journal-fake');
  return {
    prepareBytesCommitWithTier: mocks.prepare,
    commitPreparedBytes: storageJournal.commit,
  };
});
vi.mock('@/server/db/prisma-owner', async () => {
  const { storageJournal } = await import('@/server/documents/__tests__/storage-journal-fake');
  return { prismaOwner: storageJournal.owner };
});
vi.mock('@/server/db/prisma-bytes', () => ({ prismaBytes: (value: Uint8Array) => value }));
vi.mock('@/server/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('@/server/documents/upload-helpers', () => ({
  createDocumentWithVersion: mocks.createDocumentWithVersion,
}));
vi.mock('@/server/container', () => ({
  evidenceService: { record: mocks.evidenceRecord },
}));

import type { TenantContext, TxClient } from '@taxtronik/db';
import { saveResearchResultToShelf } from '../research-shelf';
import {
  processCrash,
  storageJournal,
  waitForEvent,
} from '@/server/documents/__tests__/storage-journal-fake';

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

function row(shelfDocumentId: string | null = null) {
  return {
    id: input.resultId,
    title: 'Ergebnis',
    body: '# Antwort',
    requestTitle: null,
    shelfDocumentId,
  };
}

function mockTx() {
  const tx = {
    $queryRaw: vi.fn(),
    $executeRaw: storageJournal.executeRaw,
    client: { findUnique: vi.fn() },
    riskResearchResult: { update: vi.fn() },
  };
  mocks.withTenantContext.mockImplementation(
    (_context: TenantContext, callback: (transaction: TxClient) => Promise<unknown>) =>
      callback(tx as unknown as TxClient),
  );
  return tx;
}

const puts = () => storageJournal.events.filter((event) => event.startsWith('put:')).length;

describe('saveResearchResultToShelf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storageJournal.reset();
    mocks.prepare.mockImplementation(storageJournal.prepare);
  });

  it('legt ein Rechercheergebnis genau einmal ab und verknüpft das Dokument', async () => {
    const tx = mockTx();
    tx.$queryRaw.mockResolvedValue([{ ...row(), requestTitle: 'Rechercheauftrag' }]);
    tx.client.findUnique.mockResolvedValue({ allowActive: true });
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
      mocks.prepare.mock.invocationCallOrder[0]!,
    );
    expect(mocks.prepare).toHaveBeenCalledWith({
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
    expect(storageJournal.rows).toEqual([
      expect.objectContaining({ source: 'risk.research.shelf', resolution: 'REFERENCED' }),
    ]);
  });

  it('gibt bei einem weiteren Klick das vorhandene Dokument zurück', async () => {
    const tx = mockTx();
    tx.$queryRaw.mockResolvedValue([row('f4499c61-327f-4e99-bfab-792ce466cfed')]);

    await expect(saveResearchResultToShelf(ctx, input)).resolves.toEqual({
      documentId: 'f4499c61-327f-4e99-bfab-792ce466cfed',
      alreadySaved: true,
    });
    expect(tx.client.findUnique).not.toHaveBeenCalled();
    expect(storageJournal.events).toEqual([]);
    expect(mocks.createDocumentWithVersion).not.toHaveBeenCalled();
    expect(tx.riskResearchResult.update).not.toHaveBeenCalled();
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
  });

  it('legt kein zweites Dokument an, wenn ein paralleler Lauf zwischendurch gewinnt', async () => {
    // Der Object-Store-Commit laeuft bewusst zwischen zwei kurzen Transaktionen
    // (kein Zeilen-Lock ueber einen Netz-Roundtrip). In dieser Luecke kann ein
    // zweiter Klick ablegen — die erneute Sperre in der Nachpruefung muss das erkennen.
    const tx = mockTx();
    const fremdesDokument = 'a1b2c3d4-0000-4000-8000-000000000001';
    tx.$queryRaw
      .mockResolvedValueOnce([row()]) // Vorpruefung: noch frei
      .mockResolvedValueOnce([row(fremdesDokument)]); // Nachpruefung: inzwischen belegt
    tx.client.findUnique.mockResolvedValue({ allowActive: true });

    await expect(saveResearchResultToShelf(ctx, input)).resolves.toEqual({
      documentId: fremdesDokument,
      alreadySaved: true,
    });
    // Objekt wurde geschrieben; die Speicherabsicht bleibt mit gebundener
    // Version offen, der Cleanup-Worker entfernt es versionsgenau.
    expect(puts()).toBe(1);
    expect(storageJournal.events).not.toContain('settle');
    expect(storageJournal.openIntents()).toEqual([
      expect.objectContaining({
        source: 'risk.research.shelf',
        storageVersionId: storageJournal.objects[0]!.versionId,
      }),
    ]);
    expect(mocks.createDocumentWithVersion).not.toHaveBeenCalled();
    expect(tx.riskResearchResult.update).not.toHaveBeenCalled();
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
  });

  it('kann nach dem Löschen des verknüpften Dokuments erneut abgelegt werden', async () => {
    const tx = mockTx();
    tx.$queryRaw.mockResolvedValue([row()]);
    tx.client.findUnique.mockResolvedValue({ allowActive: true });
    mocks.createDocumentWithVersion.mockResolvedValue({
      document: { id: '1e96cdee-f4bc-4da0-8cc3-96f547b55398' },
      version: { id: 'version-2' },
    });

    await expect(saveResearchResultToShelf(ctx, input)).resolves.toEqual({
      documentId: '1e96cdee-f4bc-4da0-8cc3-96f547b55398',
      alreadySaved: false,
    });
    expect(puts()).toBe(1);
  });

  it('behält die GwG-Schranke vor der Dokumentanlage bei', async () => {
    const tx = mockTx();
    tx.$queryRaw.mockResolvedValue([row()]);
    tx.client.findUnique.mockResolvedValue({ allowActive: false });

    await expect(saveResearchResultToShelf(ctx, input)).rejects.toThrow('GwG-Prüfung ausstehend');
    expect(storageJournal.events).toEqual([]);
    expect(mocks.createDocumentWithVersion).not.toHaveBeenCalled();
  });

  it('laesst die Speicherabsicht offen, wenn die zweite DB-Transaktion scheitert', async () => {
    const tx = mockTx();
    tx.$queryRaw
      .mockResolvedValueOnce([row()])
      .mockRejectedValueOnce(new Error('database unavailable'));
    tx.client.findUnique.mockResolvedValue({ allowActive: true });

    await expect(saveResearchResultToShelf(ctx, input)).rejects.toThrow('database unavailable');

    expect(storageJournal.openIntents()).toEqual([
      expect.objectContaining({
        source: 'risk.research.shelf',
        storageVersionId: storageJournal.objects[0]!.versionId,
        failure: 'database unavailable',
      }),
    ]);
  });

  // K-06: Prozessabbruch zwischen Object-Write und DB-Commit (erzeugte Ablagen).
  it('hinterlaesst nach einem Abbruch zwischen PUT und DB-Commit eine aufloesbare Speicherabsicht', async () => {
    const tx = mockTx();
    tx.$queryRaw.mockResolvedValue([row()]);
    tx.client.findUnique.mockResolvedValue({ allowActive: true });
    mocks.withTenantContext
      .mockImplementationOnce(
        (_context: TenantContext, callback: (transaction: TxClient) => Promise<unknown>) =>
          callback(tx as unknown as TxClient),
      )
      .mockImplementationOnce(() => processCrash());

    void saveResearchResultToShelf(ctx, input);
    await waitForEvent('put:');

    const [intent] = storageJournal.openIntents();
    expect(intent).toMatchObject({ source: 'risk.research.shelf', immutable: false });
    expect(storageJournal.workerContract(intent!)).toEqual({
      selectable: true,
      tenantPrefix: true,
      objectVersions: 1,
      retentionGated: true,
    });
  });
});
