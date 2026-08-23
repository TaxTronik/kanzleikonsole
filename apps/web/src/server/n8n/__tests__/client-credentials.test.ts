import { beforeEach, describe, expect, it, vi } from 'vitest';

const { safeFetchMock } = vi.hoisted(() => ({ safeFetchMock: vi.fn() }));
vi.mock('@/server/http/ssrf-guard', () => ({ safeFetchN8n: safeFetchMock }));

import { N8nApiClient } from '../client';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => vi.clearAllMocks());

describe('N8nApiClient credentials', () => {
  it('erstellt ein Header-Credential ausschließlich über die Public API', async () => {
    safeFetchMock.mockResolvedValue(
      jsonResponse({ id: 'cred-1', name: 'TaxTronik Rückkanal', type: 'httpHeaderAuth' }),
    );
    const client = new N8nApiClient('https://n8n.example.test/api/v1', 'api-key');

    await expect(
      client.createCredential({
        name: 'TaxTronik Rückkanal',
        type: 'httpHeaderAuth',
        data: { name: 'Authorization', value: 'Bearer key.token' },
      }),
    ).resolves.toEqual({ id: 'cred-1', name: 'TaxTronik Rückkanal', type: 'httpHeaderAuth' });

    expect(safeFetchMock).toHaveBeenCalledWith(
      'https://n8n.example.test/api/v1/credentials',
      'api',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'X-N8N-API-KEY': 'api-key',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'TaxTronik Rückkanal',
          type: 'httpHeaderAuth',
          data: { name: 'Authorization', value: 'Bearer key.token' },
        }),
      }),
    );
  });

  it('paginiert Credential-Metadaten ohne Secret-Daten anzufordern', async () => {
    safeFetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: 'cred-1', name: 'Erstes', type: 'httpHeaderAuth' }],
          nextCursor: 'next-page',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: 'cred-2', name: 'Zweites', type: 'smtp' }],
          nextCursor: null,
        }),
      );
    const client = new N8nApiClient('https://n8n.example.test/api/v1', 'api-key');

    await expect(client.listCredentials()).resolves.toHaveLength(2);
    expect(safeFetchMock.mock.calls[0]?.[0]).toBe(
      'https://n8n.example.test/api/v1/credentials?limit=250',
    );
    expect(safeFetchMock.mock.calls[1]?.[0]).toBe(
      'https://n8n.example.test/api/v1/credentials?limit=250&cursor=next-page',
    );
  });
});
