import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { withTenantContextMock, updateMock, evidenceRecordMock } = vi.hoisted(() => ({
  withTenantContextMock: vi.fn(),
  updateMock: vi.fn(),
  evidenceRecordMock: vi.fn(),
}));

vi.mock('@taxtronik/db', () => ({
  withTenantContext: withTenantContextMock,
}));

vi.mock('@/server/container', () => ({
  evidenceService: { record: evidenceRecordMock },
}));

import { grantN8nCallbackScopes, rotateN8nCallbackCredential } from '../callback-credentials';

const TENANT_ID = randomUUID();
const ACTOR_ID = randomUUID();
const CONNECTION_ID = randomUUID();
const KEY_ID = randomUUID();
const context = {
  tenantId: TENANT_ID,
  actorId: ACTOR_ID,
  actorType: 'STAFF' as const,
};
const tx = { n8nConnection: { update: updateMock } };

beforeEach(() => {
  vi.clearAllMocks();
  withTenantContextMock.mockImplementation(
    async (_context: unknown, callback: (transaction: typeof tx) => Promise<unknown>) =>
      callback(tx),
  );
  updateMock.mockResolvedValue({
    id: CONNECTION_ID,
    callbackKeyId: KEY_ID,
    callbackScopes: ['research:write'],
    callbackBaseUrl: null,
    kind: 'BUNDLED',
  });
  evidenceRecordMock.mockResolvedValue({ id: randomUUID() });
});

describe('rotateN8nCallbackCredential', () => {
  it('schreibt Token-Hash und Audit im selben Tenant-Transaktionscallback', async () => {
    const result = await rotateN8nCallbackCredential(context, ['research:write']);

    expect(result.token).toMatch(/^ttn8n_[A-Za-z0-9_-]{48}$/);
    expect(result.connection).toMatchObject({ id: CONNECTION_ID, callbackKeyId: KEY_ID });
    expect(withTenantContextMock).toHaveBeenCalledWith(context, expect.any(Function));
    expect(updateMock).toHaveBeenCalledWith({
      where: { tenantId: TENANT_ID },
      data: {
        callbackTokenHash: createHash('sha256').update(result.token, 'utf8').digest('hex'),
        callbackScopes: ['research:write'],
      },
      select: {
        id: true,
        callbackKeyId: true,
        callbackScopes: true,
        callbackBaseUrl: true,
        kind: true,
      },
    });
    expect(evidenceRecordMock).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        tenantId: TENANT_ID,
        actorId: ACTOR_ID,
        action: 'tenant.settings.n8n.callback_token.rotate',
        resourceId: CONNECTION_ID,
        after: {
          callbackKeyId: KEY_ID,
          scopes: ['research:write'],
          token: '***',
        },
      }),
    );
    expect(updateMock.mock.invocationCallOrder[0]).toBeLessThan(
      evidenceRecordMock.mock.invocationCallOrder[0]!,
    );
  });

  it('gibt bei Auditfehler keinen Klartext-Token aus und lässt die Transaktion scheitern', async () => {
    evidenceRecordMock.mockRejectedValue(new Error('evidence write failed'));

    await expect(rotateN8nCallbackCredential(context, ['research:write'])).rejects.toThrow(
      'evidence write failed',
    );

    expect(updateMock).toHaveBeenCalledOnce();
    expect(evidenceRecordMock).toHaveBeenCalledWith(tx, expect.any(Object));
  });

  it('schreibt kein Audit, wenn bereits das Credential-Update fehlschlägt', async () => {
    updateMock.mockRejectedValue(new Error('connection update failed'));

    await expect(rotateN8nCallbackCredential(context, ['research:write'])).rejects.toThrow(
      'connection update failed',
    );
    expect(evidenceRecordMock).not.toHaveBeenCalled();
  });

  it('erweitert Scopes ohne Tokenrotation und auditiert die Änderung', async () => {
    await grantN8nCallbackScopes(context, ['gwg:read', 'requests:read']);

    expect(updateMock).toHaveBeenCalledWith({
      where: { tenantId: TENANT_ID },
      data: { callbackScopes: ['gwg:read', 'requests:read'] },
      select: { id: true, callbackKeyId: true },
    });
    expect(evidenceRecordMock).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'tenant.settings.n8n.callback_scope.update',
        after: {
          callbackKeyId: KEY_ID,
          scopes: ['gwg:read', 'requests:read'],
        },
      }),
    );
  });
});
