import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rotateMock, grantMock } = vi.hoisted(() => ({
  rotateMock: vi.fn(),
  grantMock: vi.fn(),
}));

vi.mock('@/server/settings/n8n', () => ({
  defaultN8nCallbackBase: () => 'http://app:3000',
}));
vi.mock('@/server/n8n/callback-credentials', () => ({
  rotateN8nCallbackCredential: rotateMock,
  grantN8nCallbackScopes: grantMock,
}));

import { managedCallbackCredentialName, prepareN8nCallbackImport } from '../callback-import-setup';
import type { N8nApiClient } from '../client';
import type { N8nConfig } from '@/server/settings/n8n';

const KEY_ID = randomUUID();
const context = { tenantId: randomUUID(), actorId: randomUUID(), actorType: 'STAFF' as const };
const config = {
  callbackKeyId: KEY_ID,
  callbackConfigured: false,
  callbackScopes: [],
  callbackBaseUrl: 'http://app:3000',
  kind: 'BUNDLED',
} as unknown as N8nConfig;

function client(overrides: Partial<N8nApiClient> = {}): N8nApiClient {
  return {
    createCredential: vi.fn(),
    listCredentials: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as N8nApiClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  rotateMock.mockResolvedValue({
    token: 'ttn8n_secret',
    connection: {
      id: randomUUID(),
      callbackKeyId: KEY_ID,
      callbackScopes: ['gwg:read'],
      callbackBaseUrl: 'http://app:3000',
      kind: 'BUNDLED',
    },
  });
  grantMock.mockResolvedValue(undefined);
});

describe('n8n callback import setup', () => {
  it('überträgt einen neuen Callback-Token als verschlüsseltes n8n-Credential', async () => {
    const createCredential = vi.fn().mockResolvedValue({
      id: 'cred-1',
      name: managedCallbackCredentialName(KEY_ID),
      type: 'httpHeaderAuth',
    });
    const result = await prepareN8nCallbackImport(
      context,
      config,
      client({ createCredential } as Partial<N8nApiClient>),
      ['gwg:read'],
    );

    expect(createCredential).toHaveBeenCalledWith({
      name: managedCallbackCredentialName(KEY_ID),
      type: 'httpHeaderAuth',
      data: { name: 'Authorization', value: `Bearer ${KEY_ID}.ttn8n_secret` },
    });
    expect(result).toMatchObject({ binding: { id: 'cred-1' }, configured: true });
    expect(result.credential).toBeUndefined();
  });

  it('zeigt das Token bei fehlendem credential:create einmalig zur manuellen Anlage', async () => {
    const result = await prepareN8nCallbackImport(
      context,
      config,
      client({
        createCredential: vi.fn().mockRejectedValue(new Error('403 forbidden')),
      } as Partial<N8nApiClient>),
      ['requests:read'],
    );

    expect(result.binding).toBeNull();
    expect(result.configured).toBe(true);
    expect(result.credential).toEqual({
      keyId: KEY_ID,
      token: 'ttn8n_secret',
      baseUrl: 'http://app:3000/api/integrations/n8n/v1',
      scopes: ['requests:read'],
    });
    expect(result.warning).toMatch(/credential:create/);
  });

  it('erweitert einen bestehenden Token und bindet das bekannte Credential erneut', async () => {
    const name = managedCallbackCredentialName(KEY_ID);
    const result = await prepareN8nCallbackImport(
      context,
      { ...config, callbackConfigured: true, callbackScopes: ['requests:read'] },
      client({
        listCredentials: vi
          .fn()
          .mockResolvedValue([{ id: 'cred-1', name, type: 'httpHeaderAuth' }]),
      } as Partial<N8nApiClient>),
      ['gwg:read'],
    );

    expect(grantMock).toHaveBeenCalledWith(context, ['gwg:read', 'requests:read']);
    expect(result.binding).toEqual({ id: 'cred-1', name, type: 'httpHeaderAuth' });
    expect(rotateMock).not.toHaveBeenCalled();
  });
});
