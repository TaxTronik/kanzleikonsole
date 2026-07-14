import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { ownerFindUniqueMock, createManyMock, findUniqueMock, updateMock } = vi.hoisted(() => ({
  ownerFindUniqueMock: vi.fn(),
  createManyMock: vi.fn(),
  findUniqueMock: vi.fn(),
  updateMock: vi.fn(),
}));

vi.mock('@/server/db/prisma-owner', () => ({
  prismaOwner: { n8nCallbackReceipt: { findUnique: ownerFindUniqueMock } },
}));

import {
  claimN8nCallbackReceipt,
  getCompletedN8nCallbackReceipt,
  hasCompletedN8nCallbackReceipt,
  N8N_CALLBACK_OPERATIONS,
  N8nCallbackReceiptConflictError,
  setN8nCallbackReceiptResult,
} from '../callback-receipts';

const key = {
  tenantId: randomUUID(),
  connectionId: randomUUID(),
  requestId: 'delivery-42',
  operation: N8N_CALLBACK_OPERATIONS.researchResult,
};
const tx = {
  n8nCallbackReceipt: {
    createMany: createManyMock,
    findUnique: findUniqueMock,
    update: updateMock,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  createManyMock.mockResolvedValue({ count: 1 });
  updateMock.mockResolvedValue({ id: randomUUID() });
});

describe('durable n8n callback receipts', () => {
  it('claimed den Hash per conflict-safe Insert in der Fachtransaktion', async () => {
    await expect(claimN8nCallbackReceipt(tx as never, key)).resolves.toEqual({
      duplicate: false,
    });

    expect(createManyMock).toHaveBeenCalledWith({
      data: {
        tenantId: key.tenantId,
        connectionId: key.connectionId,
        requestIdHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        operation: 'research-result',
      },
      skipDuplicates: true,
    });
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it('liefert nur einen vollständig sichtbaren gleichen Receipt als Duplicate', async () => {
    const resultId = randomUUID();
    createManyMock.mockResolvedValue({ count: 0 });
    findUniqueMock.mockResolvedValue({
      tenantId: key.tenantId,
      operation: key.operation,
      resultId,
    });

    await expect(claimN8nCallbackReceipt(tx as never, key)).resolves.toEqual({
      duplicate: true,
      resultId,
    });
  });

  it('verhindert die Wiederverwendung derselben ID für eine andere Operation', async () => {
    createManyMock.mockResolvedValue({ count: 0 });
    findUniqueMock.mockResolvedValue({
      tenantId: key.tenantId,
      operation: 'request-inbound',
      resultId: null,
    });

    await expect(claimN8nCallbackReceipt(tx as never, key)).rejects.toBeInstanceOf(
      N8nCallbackReceiptConflictError,
    );
  });

  it('speichert die Research-Ergebnis-ID unter demselben Hash', async () => {
    const resultId = randomUUID();

    await setN8nCallbackReceiptResult(tx as never, key, resultId);

    expect(updateMock).toHaveBeenCalledWith({
      where: {
        connectionId_requestIdHash: {
          connectionId: key.connectionId,
          requestIdHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
      data: { resultId },
    });
  });

  it('erkennt Crash-Recovery nur bei Tenant und Operation des DB-Receipts', async () => {
    const resultId = randomUUID();
    ownerFindUniqueMock.mockResolvedValue({
      tenantId: key.tenantId,
      operation: key.operation,
      resultId,
    });
    await expect(getCompletedN8nCallbackReceipt(key)).resolves.toEqual({ resultId });
    await expect(hasCompletedN8nCallbackReceipt(key)).resolves.toBe(true);

    ownerFindUniqueMock.mockResolvedValue({
      tenantId: key.tenantId,
      operation: 'request-inbound',
    });
    await expect(hasCompletedN8nCallbackReceipt(key)).resolves.toBe(false);
  });
});
