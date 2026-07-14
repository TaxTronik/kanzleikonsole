import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyMock, gwgMock } = vi.hoisted(() => ({
  verifyMock: vi.fn(),
  gwgMock: vi.fn(),
}));

vi.mock('@/server/n8n/verify', () => ({
  verifyN8nSignature: verifyMock,
  runReservedN8nRequest: (_verification: unknown, operation: () => Promise<NextResponse>) =>
    operation(),
  n8nRejectResponse: (failure: { status: number }) =>
    NextResponse.json({ error: 'unauthorized' }, { status: failure.status }),
}));

vi.mock('@/server/n8n/operations', () => ({ getExpiringGwgChecks: gwgMock }));
vi.mock('@/server/n8n/legacy-access', () => ({
  legacyN8nCallbackDisabledResponse: () => null,
}));
vi.mock('@/server/logger', () => ({ log: { warn: vi.fn() } }));

import { GET } from '@/app/api/n8n/expiring-gwg-checks/route';

beforeEach(() => {
  vi.clearAllMocks();
  verifyMock.mockResolvedValue({ ok: true });
  gwgMock.mockResolvedValue({ count: 0, checks: [] });
});

describe('Legacy-n8n-GwG-Route', () => {
  it('verweigert den früheren globalen Cross-Tenant-Read ohne tenantId', async () => {
    const response = await GET(
      new NextRequest('http://localhost/api/n8n/expiring-gwg-checks?withinDays=30'),
    );

    expect(response.status).toBe(400);
    expect(gwgMock).not.toHaveBeenCalled();
  });

  it('bindet auch Legacy-Aufrufe an den explizit signierten Tenant', async () => {
    const tenantId = randomUUID();
    const response = await GET(
      new NextRequest(
        `http://localhost/api/n8n/expiring-gwg-checks?withinDays=45&tenantId=${tenantId}`,
      ),
    );

    expect(response.status).toBe(200);
    expect(gwgMock).toHaveBeenCalledWith(tenantId, 45);
  });
});
