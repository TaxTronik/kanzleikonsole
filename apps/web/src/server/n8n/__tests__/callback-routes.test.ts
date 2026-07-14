import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  authenticateMock,
  runReservedMock,
  overdueMock,
  researchMock,
  inboundMock,
  gwgMock,
  detailMock,
  getCompletedReceiptMock,
} = vi.hoisted(() => ({
  authenticateMock: vi.fn(),
  runReservedMock: vi.fn(),
  overdueMock: vi.fn(),
  researchMock: vi.fn(),
  inboundMock: vi.fn(),
  gwgMock: vi.fn(),
  detailMock: vi.fn(),
  getCompletedReceiptMock: vi.fn(),
}));

vi.mock('@/server/n8n/callback-auth', () => ({
  authenticateN8nCallback: authenticateMock,
  runReservedN8nCallback: runReservedMock,
  n8nCallbackRejectResponse: (failure: { status: number; error: string }) =>
    NextResponse.json({ error: failure.error }, { status: failure.status }),
}));

vi.mock('@/server/n8n/operations', () => ({
  getOverdueRequestsForTenant: overdueMock,
  receiveResearchResultForTenant: researchMock,
  handleInboundRequestEmail: inboundMock,
  getExpiringGwgChecks: gwgMock,
  getRequestDetailForTenant: detailMock,
}));

vi.mock('@/server/n8n/callback-receipts', () => ({
  getCompletedN8nCallbackReceipt: getCompletedReceiptMock,
  N8N_CALLBACK_OPERATIONS: {
    inboundMail: 'request-inbound',
    researchResult: 'research-result',
  },
  N8nCallbackReceiptConflictError: class N8nCallbackReceiptConflictError extends Error {},
}));

vi.mock('@/server/logger', () => ({ log: { warn: vi.fn() } }));

import { GET as getOverdue } from '@/app/api/integrations/n8n/v1/overdue-requests/route';
import { GET as getGwg } from '@/app/api/integrations/n8n/v1/expiring-gwg-checks/route';
import { GET as getDetail } from '@/app/api/integrations/n8n/v1/request-detail/[id]/route';
import { POST as postInbound } from '@/app/api/integrations/n8n/v1/request-inbound/route';
import { POST as postResearch } from '@/app/api/integrations/n8n/v1/research-result/route';

const TENANT_ID = randomUUID();
const AUTH = {
  ok: true as const,
  connectionId: randomUUID(),
  tenantId: TENANT_ID,
  requestId: 'execution-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  authenticateMock.mockResolvedValue(AUTH);
  runReservedMock.mockImplementation((_auth: typeof AUTH, operation: () => Promise<NextResponse>) =>
    operation(),
  );
  overdueMock.mockResolvedValue({ count: 0, requests: [] });
  gwgMock.mockResolvedValue({ count: 0, checks: [] });
  detailMock.mockResolvedValue({ id: randomUUID() });
  inboundMock.mockResolvedValue({ status: 200, duplicate: false });
  researchMock.mockResolvedValue({ resultId: randomUUID(), duplicate: false });
  getCompletedReceiptMock.mockResolvedValue(null);
});

describe('tenantgebundene n8n-v1-Routen', () => {
  it('reserviert einen validen Read erst nach Query-Validierung', async () => {
    const response = await getOverdue(
      new NextRequest('http://localhost/api/integrations/n8n/v1/overdue-requests'),
    );

    expect(response.status).toBe(200);
    expect(runReservedMock).toHaveBeenCalledWith(AUTH, expect.any(Function));
    expect(overdueMock).toHaveBeenCalledWith(TENANT_ID);
  });

  it('verbraucht bei verbotenem tenantId in der Query keine Request-ID', async () => {
    const response = await getOverdue(
      new NextRequest(
        `http://localhost/api/integrations/n8n/v1/overdue-requests?tenantId=${randomUUID()}`,
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'tenant_id_not_allowed' });
    expect(runReservedMock).not.toHaveBeenCalled();
    expect(overdueMock).not.toHaveBeenCalled();
  });

  it('verbraucht bei ungueltigem withinDays keine Request-ID', async () => {
    const response = await getGwg(
      new NextRequest('http://localhost/api/integrations/n8n/v1/expiring-gwg-checks?withinDays=0'),
    );

    expect(response.status).toBe(400);
    expect(runReservedMock).not.toHaveBeenCalled();
    expect(gwgMock).not.toHaveBeenCalled();
  });

  it('verbraucht bei ungueltiger Request-ID im Pfad keine Callback-Request-ID', async () => {
    const response = await getDetail(
      new NextRequest('http://localhost/api/integrations/n8n/v1/request-detail/not-a-uuid'),
      { params: Promise.resolve({ id: 'not-a-uuid' }) },
    );

    expect(response.status).toBe(400);
    expect(runReservedMock).not.toHaveBeenCalled();
    expect(detailMock).not.toHaveBeenCalled();
  });

  it('reserviert Inbound-Mail erst nach strikter Body-Validierung', async () => {
    const body = { requestId: randomUUID(), fromEmail: 'mandant@example.test', message: 'Antwort' };
    const response = await postInbound(
      new NextRequest('http://localhost/api/integrations/n8n/v1/request-inbound', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

    expect(response.status).toBe(200);
    expect(runReservedMock).toHaveBeenCalledWith(
      AUTH,
      expect.any(Function),
      expect.objectContaining({ onReplay: expect.any(Function) }),
    );
    expect(inboundMock).toHaveBeenCalledWith(
      TENANT_ID,
      body,
      expect.objectContaining({
        tenantId: TENANT_ID,
        connectionId: AUTH.connectionId,
        requestId: AUTH.requestId,
        operation: 'request-inbound',
      }),
    );
  });

  it('verbraucht bei ungueltigem Inbound-Mail-Body keine Request-ID', async () => {
    const response = await postInbound(
      new NextRequest('http://localhost/api/integrations/n8n/v1/request-inbound', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: randomUUID(), message: 'Absender fehlt' }),
      }),
    );

    expect(response.status).toBe(400);
    expect(runReservedMock).not.toHaveBeenCalled();
    expect(inboundMock).not.toHaveBeenCalled();
  });

  it('uebergibt Research ausschliesslich mit Connection-Tenant unter Reservation', async () => {
    const body = { researchRequestId: randomUUID(), body: 'Ergebnis', source: 'n8n' };
    const response = await postResearch(
      new NextRequest('http://localhost/api/integrations/n8n/v1/research-result', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

    expect(response.status).toBe(200);
    expect(runReservedMock).toHaveBeenCalledWith(
      AUTH,
      expect.any(Function),
      expect.objectContaining({ onReplay: expect.any(Function) }),
    );
    expect(researchMock).toHaveBeenCalledWith(
      TENANT_ID,
      body,
      expect.objectContaining({
        tenantId: TENANT_ID,
        connectionId: AUTH.connectionId,
        requestId: AUTH.requestId,
        operation: 'research-result',
      }),
    );
  });

  it('verbraucht bei tenantId oder ungueltigem Research-Body keine Request-ID', async () => {
    const response = await postResearch(
      new NextRequest('http://localhost/api/integrations/n8n/v1/research-result', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenantId: randomUUID(), body: 'Ergebnis' }),
      }),
    );

    expect(response.status).toBe(400);
    expect(runReservedMock).not.toHaveBeenCalled();
    expect(researchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['request-inbound', postInbound, inboundMock],
    ['research-result', postResearch, researchMock],
  ] as const)(
    'bestätigt einen DB-belegten %s-Replay mit 2xx ohne Side Effect',
    async (route, handler, operationMock) => {
      const receiptResultId = randomUUID();
      getCompletedReceiptMock.mockResolvedValue({
        resultId: route === 'research-result' ? receiptResultId : null,
      });
      const body =
        route === 'request-inbound'
          ? { requestId: randomUUID(), fromEmail: 'mandant@example.test', message: 'Antwort' }
          : { researchRequestId: randomUUID(), body: 'Ergebnis' };

      const response = await handler(
        new NextRequest(`http://localhost/api/integrations/n8n/v1/${route}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(
        route === 'research-result'
          ? { ok: true, resultId: receiptResultId, duplicate: true }
          : { ok: true, duplicate: true },
      );
      expect(operationMock).not.toHaveBeenCalled();
    },
  );
});
