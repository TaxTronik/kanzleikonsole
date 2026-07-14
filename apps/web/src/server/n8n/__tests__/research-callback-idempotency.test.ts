import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  withSystemContext: vi.fn(),
  withTenantContext: vi.fn(),
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
});
