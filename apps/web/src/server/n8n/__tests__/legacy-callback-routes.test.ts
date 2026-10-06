import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  verifyMock,
  runReservedMock,
  overdueMock,
  gwgMock,
  detailMock,
  inboundMock,
  researchMock,
  reportMock,
  legacyEnv,
} = vi.hoisted(() => ({
  verifyMock: vi.fn(),
  runReservedMock: vi.fn(),
  overdueMock: vi.fn(),
  gwgMock: vi.fn(),
  detailMock: vi.fn(),
  inboundMock: vi.fn(),
  researchMock: vi.fn(),
  reportMock: vi.fn(),
  legacyEnv: { N8N_LEGACY_CALLBACKS_ENABLED: true },
}));

vi.mock('@taxtronik/config', () => ({ env: legacyEnv }));

vi.mock('@/server/n8n/verify', () => ({
  verifyN8nSignature: verifyMock,
  runReservedN8nRequest: runReservedMock,
  n8nRejectResponse: (failure: { status: number }) =>
    NextResponse.json({ error: 'unauthorized' }, { status: failure.status }),
}));

vi.mock('@/server/n8n/operations', () => ({
  getOverdueRequestsForTenant: overdueMock,
  getExpiringGwgChecks: gwgMock,
  getRequestDetailForTenant: detailMock,
  handleInboundRequestEmail: inboundMock,
}));

vi.mock('@/server/risk', () => ({ receiveResearchResult: researchMock }));
vi.mock('@/server/logger', () => ({ log: { warn: vi.fn() } }));
vi.mock('@/server/n8n/legacy-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/n8n/legacy-access')>()),
  reportLegacyN8nCallbackUse: reportMock,
}));

import { GET as getGwg } from '@/app/api/n8n/expiring-gwg-checks/route';
import { GET as getOverdue } from '@/app/api/n8n/overdue-requests/route';
import { GET as getDetail } from '@/app/api/n8n/request-detail/[id]/route';
import { POST as postInbound } from '@/app/api/n8n/request-inbound/route';
import { POST as postResearch } from '@/app/api/n8n/research-result/route';

const TENANT_ID = randomUUID();
const REQUEST_ID = randomUUID();
const VERIFIED = { ok: true as const, body: '', replayId: 'sha256=verified' };

function postRequest(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  legacyEnv.N8N_LEGACY_CALLBACKS_ENABLED = true;
  verifyMock.mockImplementation(async (request: NextRequest) => ({
    ...VERIFIED,
    body: request.method === 'GET' ? '' : await request.text(),
  }));
  runReservedMock.mockImplementation(
    (_verification: typeof VERIFIED, operation: () => Promise<NextResponse>) => operation(),
  );
  overdueMock.mockResolvedValue({ count: 0, requests: [] });
  gwgMock.mockResolvedValue({ count: 0, checks: [] });
  detailMock.mockResolvedValue({ id: REQUEST_ID });
  inboundMock.mockResolvedValue({ status: 200 });
  researchMock.mockResolvedValue({ resultId: randomUUID() });
});

describe('Legacy-n8n-Aliase sind default-off', () => {
  it('liefert für alle Routen vor Auth, Body und Fachlogik denselben leeren 404', async () => {
    legacyEnv.N8N_LEGACY_CALLBACKS_ENABLED = false;

    const responses = [
      await getOverdue(
        new NextRequest(`http://localhost/api/n8n/overdue-requests?tenantId=${TENANT_ID}`),
      ),
      await getGwg(
        new NextRequest(
          `http://localhost/api/n8n/expiring-gwg-checks?tenantId=${TENANT_ID}&withinDays=30`,
        ),
      ),
      await getDetail(
        new NextRequest(
          `http://localhost/api/n8n/request-detail/${REQUEST_ID}?tenantId=${TENANT_ID}`,
        ),
        { params: Promise.resolve({ id: REQUEST_ID }) },
      ),
      await postInbound(postRequest('/api/n8n/request-inbound', '{not even parsed')),
      await postResearch(postRequest('/api/n8n/research-result', '{not even parsed')),
    ];

    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
      await expect(response.text()).resolves.toBe('');
    }
    expect(verifyMock).not.toHaveBeenCalled();
    expect(runReservedMock).not.toHaveBeenCalled();
    expect(overdueMock).not.toHaveBeenCalled();
    expect(gwgMock).not.toHaveBeenCalled();
    expect(detailMock).not.toHaveBeenCalled();
    expect(inboundMock).not.toHaveBeenCalled();
    expect(researchMock).not.toHaveBeenCalled();
    expect(reportMock).not.toHaveBeenCalled();
  });
});

describe('Legacy-n8n-Aliase melden ihre Nutzung für die Abschaltentscheidung', () => {
  async function callAllRoutes() {
    return [
      await getOverdue(
        new NextRequest(`http://localhost/api/n8n/overdue-requests?tenantId=${TENANT_ID}`),
      ),
      await getGwg(
        new NextRequest(
          `http://localhost/api/n8n/expiring-gwg-checks?tenantId=${TENANT_ID}&withinDays=30`,
        ),
      ),
      await getDetail(
        new NextRequest(
          `http://localhost/api/n8n/request-detail/${REQUEST_ID}?tenantId=${TENANT_ID}`,
        ),
        { params: Promise.resolve({ id: REQUEST_ID }) },
      ),
      await postInbound(
        postRequest('/api/n8n/request-inbound', {
          tenantId: TENANT_ID,
          requestId: REQUEST_ID,
          fromEmail: 'mandant@example.test',
          message: 'Antwort',
        }),
      ),
      await postResearch(
        postRequest('/api/n8n/research-result', { tenantId: TENANT_ID, body: 'Ergebnis' }),
      ),
    ];
  }

  it('meldet jede Route nach erfolgreicher Signaturprüfung', async () => {
    const responses = await callAllRoutes();

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
    expect(reportMock.mock.calls).toEqual([
      ['overdue-requests'],
      ['expiring-gwg-checks'],
      ['request-detail'],
      ['request-inbound'],
      ['research-result'],
    ]);
  });

  it('meldet keine Nutzung, wenn die Signatur abgewiesen wird', async () => {
    verifyMock.mockResolvedValue({ ok: false, error: 'signature mismatch', status: 401 });

    const responses = await callAllRoutes();

    expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401, 401]);
    expect(reportMock).not.toHaveBeenCalled();
  });
});

describe('Legacy-n8n-Aliase reservieren erst nach Validierung', () => {
  it('deckt overdue-requests ab', async () => {
    const valid = await getOverdue(
      new NextRequest(`http://localhost/api/n8n/overdue-requests?tenantId=${TENANT_ID}`),
    );
    expect(valid.status).toBe(200);
    expect(runReservedMock).toHaveBeenCalledOnce();
    expect(overdueMock).toHaveBeenCalledWith(TENANT_ID);

    vi.clearAllMocks();
    verifyMock.mockResolvedValue(VERIFIED);
    const invalid = await getOverdue(new NextRequest('http://localhost/api/n8n/overdue-requests'));
    expect(invalid.status).toBe(400);
    expect(runReservedMock).not.toHaveBeenCalled();
  });

  it('deckt expiring-gwg-checks ab', async () => {
    const valid = await getGwg(
      new NextRequest(
        `http://localhost/api/n8n/expiring-gwg-checks?tenantId=${TENANT_ID}&withinDays=30`,
      ),
    );
    expect(valid.status).toBe(200);
    expect(runReservedMock).toHaveBeenCalledOnce();
    expect(gwgMock).toHaveBeenCalledWith(TENANT_ID, 30);

    vi.clearAllMocks();
    verifyMock.mockResolvedValue(VERIFIED);
    const invalid = await getGwg(
      new NextRequest(
        `http://localhost/api/n8n/expiring-gwg-checks?tenantId=${TENANT_ID}&withinDays=0`,
      ),
    );
    expect(invalid.status).toBe(400);
    expect(runReservedMock).not.toHaveBeenCalled();
  });

  it('deckt request-detail inklusive Pfadparameter ab', async () => {
    const valid = await getDetail(
      new NextRequest(
        `http://localhost/api/n8n/request-detail/${REQUEST_ID}?tenantId=${TENANT_ID}`,
      ),
      { params: Promise.resolve({ id: REQUEST_ID }) },
    );
    expect(valid.status).toBe(200);
    expect(runReservedMock).toHaveBeenCalledOnce();
    expect(detailMock).toHaveBeenCalledWith(TENANT_ID, REQUEST_ID);

    vi.clearAllMocks();
    verifyMock.mockResolvedValue(VERIFIED);
    const invalid = await getDetail(
      new NextRequest(`http://localhost/api/n8n/request-detail/not-a-uuid?tenantId=${TENANT_ID}`),
      { params: Promise.resolve({ id: 'not-a-uuid' }) },
    );
    expect(invalid.status).toBe(400);
    expect(runReservedMock).not.toHaveBeenCalled();
  });

  it('deckt request-inbound ab', async () => {
    const valid = await postInbound(
      postRequest('/api/n8n/request-inbound', {
        tenantId: TENANT_ID,
        requestId: REQUEST_ID,
        fromEmail: 'mandant@example.test',
        message: 'Antwort',
      }),
    );
    expect(valid.status).toBe(200);
    expect(runReservedMock).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    verifyMock.mockResolvedValue({ ...VERIFIED, body: '{invalid' });
    const invalid = await postInbound(postRequest('/api/n8n/request-inbound', '{invalid'));
    expect(invalid.status).toBe(400);
    expect(runReservedMock).not.toHaveBeenCalled();
  });

  it('deckt research-result ab', async () => {
    const valid = await postResearch(
      postRequest('/api/n8n/research-result', {
        tenantId: TENANT_ID,
        body: 'Rechercheergebnis',
      }),
    );
    expect(valid.status).toBe(200);
    expect(runReservedMock).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    verifyMock.mockResolvedValue({
      ...VERIFIED,
      body: JSON.stringify({ body: 'Korrelation fehlt' }),
    });
    const invalid = await postResearch(
      postRequest('/api/n8n/research-result', { body: 'Korrelation fehlt' }),
    );
    expect(invalid.status).toBe(400);
    expect(runReservedMock).not.toHaveBeenCalled();
  });
});
