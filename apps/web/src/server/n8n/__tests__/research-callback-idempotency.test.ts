import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  withSystemContext: vi.fn(),
  withTenantContext: vi.fn(),
  readBooleanTenantModules: vi.fn(),
  researchRequestFindUnique: vi.fn(),
  resultCreate: vi.fn(),
  requestUpdateMany: vi.fn(),
  evidenceRecord: vi.fn(),
  notify: vi.fn(),
  claimReceipt: vi.fn(),
  setReceiptResult: vi.fn(),
}));

vi.mock('@taxtronik/db', () => ({
  withSystemContext: h.withSystemContext,
  withTenantContext: h.withTenantContext,
  readBooleanTenantModules: h.readBooleanTenantModules,
}));
vi.mock('@/server/db/prisma-owner', () => ({
  prismaOwner: { riskResearchRequest: { findUnique: h.researchRequestFindUnique } },
}));
vi.mock('@/server/n8n/outbox', () => ({ enqueueN8nEvent: vi.fn() }));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.evidenceRecord } }));
vi.mock('@/server/notifications/service', () => ({ notify: h.notify }));
vi.mock('@/server/n8n/callback-receipts', () => ({
  claimN8nCallbackReceipt: h.claimReceipt,
  setN8nCallbackReceiptResult: h.setReceiptResult,
}));

import { receiveResearchResult } from '@/server/risk/research';

const TENANT_ID = randomUUID();
const CONNECTION_ID = randomUUID();
const RESULT_ID = randomUUID();
const callbackReceipt = {
  tenantId: TENANT_ID,
  connectionId: CONNECTION_ID,
  requestId: 'delivery-04',
  operation: 'research-result' as const,
};
const tx = {
  riskResearchRequest: { updateMany: h.requestUpdateMany },
  riskResearchResult: { create: h.resultCreate },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.researchRequestFindUnique.mockResolvedValue(null);
  h.readBooleanTenantModules.mockResolvedValue({ risk: true });
  h.withSystemContext.mockImplementation(
    async (_tenantId: string, callback: (transaction: typeof tx) => Promise<unknown>) =>
      callback(tx),
  );
  h.claimReceipt.mockResolvedValue({ duplicate: false });
  h.resultCreate.mockResolvedValue({ id: RESULT_ID });
  h.setReceiptResult.mockResolvedValue(undefined);
  h.evidenceRecord.mockResolvedValue({ id: randomUUID() });
  h.notify.mockResolvedValue(undefined);
});

describe('research callback transaction idempotency', () => {
  it('lehnt den direkten Worker-Callback ohne Mutation ab, wenn Risk deaktiviert ist', async () => {
    h.readBooleanTenantModules.mockResolvedValue({ risk: false });

    await expect(
      receiveResearchResult(
        { tenantId: TENANT_ID, body: 'Ergebnis', source: 'n8n' },
        callbackReceipt,
      ),
    ).resolves.toBeNull();

    expect(h.readBooleanTenantModules).toHaveBeenCalledWith(expect.any(Object), TENANT_ID);
    expect(h.withSystemContext).not.toHaveBeenCalled();
    expect(h.resultCreate).not.toHaveBeenCalled();
    expect(h.claimReceipt).not.toHaveBeenCalled();
  });

  it('committed Receipt, Ergebnis-ID und Fachmutation in derselben System-Transaktion', async () => {
    const result = await receiveResearchResult(
      { tenantId: TENANT_ID, body: 'Ergebnis', source: 'n8n' },
      callbackReceipt,
    );

    expect(result).toEqual({ resultId: RESULT_ID, duplicate: false });
    expect(h.claimReceipt).toHaveBeenCalledWith(tx, callbackReceipt);
    expect(h.claimReceipt.mock.invocationCallOrder[0]).toBeLessThan(
      h.resultCreate.mock.invocationCallOrder[0]!,
    );
    expect(h.setReceiptResult).toHaveBeenCalledWith(tx, callbackReceipt, RESULT_ID);
    expect(h.evidenceRecord).toHaveBeenCalledWith(tx, expect.any(Object));
  });

  it('liefert das gespeicherte Outcome ohne zweite Mutation oder Auditzeile', async () => {
    h.claimReceipt.mockResolvedValue({ duplicate: true, resultId: RESULT_ID });

    await expect(
      receiveResearchResult(
        { tenantId: TENANT_ID, body: 'Ergebnis', source: 'n8n' },
        callbackReceipt,
      ),
    ).resolves.toEqual({ resultId: RESULT_ID, duplicate: true });

    expect(h.resultCreate).not.toHaveBeenCalled();
    expect(h.setReceiptResult).not.toHaveBeenCalled();
    expect(h.evidenceRecord).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('benachrichtigt den Auftraggeber und verlinkt direkt in den Recherche-Tab', async () => {
    const requestId = randomUUID();
    const staffId = randomUUID();
    const clientId = randomUUID();
    const analysisId = randomUUID();
    h.researchRequestFindUnique.mockResolvedValue({
      tenantId: TENANT_ID,
      markingId: null,
      title: 'Umsatzsteuerliche Würdigung',
      mapping: {},
      createdById: staffId,
      analysisId,
      analysis: { clientId },
    });

    await receiveResearchResult({
      researchRequestId: requestId,
      body: 'Ergebnis',
      source: 'n8n',
    });

    expect(h.notify).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        tenantId: TENANT_ID,
        staffId,
        title: 'Rechercheergebnis eingegangen: Umsatzsteuerliche Würdigung',
        href: `/staff/clients/${clientId}/subsumtion/${analysisId}?view=recherche`,
        resourceType: 'risk_research_result',
        resourceId: RESULT_ID,
      }),
    );
  });

  it('legt verschiedene Rechercheaufträge als getrennte Ergebnisse an', async () => {
    const firstRequestId = randomUUID();
    const secondRequestId = randomUUID();
    const firstResultId = randomUUID();
    const secondResultId = randomUUID();
    const requestBase = {
      tenantId: TENANT_ID,
      markingId: null,
      mapping: {},
      createdById: randomUUID(),
      analysisId: randomUUID(),
      analysis: { clientId: randomUUID() },
    };
    h.researchRequestFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === firstRequestId
        ? { ...requestBase, title: 'Erste Recherche' }
        : { ...requestBase, title: 'Zweite Recherche' },
    );
    h.resultCreate
      .mockResolvedValueOnce({ id: firstResultId })
      .mockResolvedValueOnce({ id: secondResultId });

    await receiveResearchResult({ researchRequestId: firstRequestId, body: 'Erstes Ergebnis' });
    await receiveResearchResult({ researchRequestId: secondRequestId, body: 'Zweites Ergebnis' });

    expect(h.resultCreate).toHaveBeenCalledTimes(2);
    expect(h.resultCreate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          researchRequestId: firstRequestId,
          title: 'Erste Recherche',
          body: 'Erstes Ergebnis',
        }),
      }),
    );
    expect(h.resultCreate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          researchRequestId: secondRequestId,
          title: 'Zweite Recherche',
          body: 'Zweites Ergebnis',
        }),
      }),
    );
  });
});
