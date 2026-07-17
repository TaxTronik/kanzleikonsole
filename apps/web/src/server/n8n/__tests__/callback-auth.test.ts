import { createHash, randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findUniqueMock, redisEvalMock, getRedisMock } = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  redisEvalMock: vi.fn(),
  getRedisMock: vi.fn(),
}));

vi.mock('@/server/db/prisma-owner', () => ({
  prismaOwner: { n8nConnection: { findUnique: findUniqueMock } },
}));

vi.mock('@/server/redis', () => ({
  getRedis: getRedisMock,
}));

vi.mock('@/server/logger', () => ({
  log: { error: vi.fn() },
}));

import { authenticateN8nCallback, runReservedN8nCallback } from '../callback-auth';

const TOKEN = 'callback-token-with-at-least-thirty-two-characters';
const KEY_ID = randomUUID();
const CONNECTION_ID = randomUUID();
const TENANT_ID = randomUUID();

function request(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/integrations/n8n/v1/overdue-requests', {
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'x-taxtronik-key-id': KEY_ID,
      'x-taxtronik-request-id': 'n8n-execution-42',
      ...headers,
    },
  });
}

async function authenticated() {
  const result = await authenticateN8nCallback(request(), 'requests:read');
  if (!result.ok) throw new Error(`Test-Authentifizierung fehlgeschlagen: ${result.reason}`);
  return result;
}

beforeEach(() => {
  findUniqueMock.mockReset();
  redisEvalMock.mockReset();
  getRedisMock.mockReset();
  findUniqueMock.mockResolvedValue({
    id: CONNECTION_ID,
    tenantId: TENANT_ID,
    enabled: true,
    callbackTokenHash: createHash('sha256').update(TOKEN).digest('hex'),
    callbackScopes: ['requests:read', 'gwg:read'],
  });
  redisEvalMock.mockResolvedValue(1);
  getRedisMock.mockReturnValue({ eval: redisEvalMock });
});

describe('authenticateN8nCallback', () => {
  it('bindet den Tenant an die Connection, ohne die Request-ID vor Validierung zu verbrauchen', async () => {
    const result = await authenticateN8nCallback(request(), 'requests:read');

    expect(result).toMatchObject({
      ok: true,
      connectionId: CONNECTION_ID,
      tenantId: TENANT_ID,
      requestId: 'n8n-execution-42',
    });
    expect(findUniqueMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { callbackKeyId: KEY_ID } }),
    );
    expect(getRedisMock).not.toHaveBeenCalled();
    expect(redisEvalMock).not.toHaveBeenCalled();
  });

  it('weist ein falsches Token vor Scope- und Replay-Pruefung zurueck', async () => {
    const result = await authenticateN8nCallback(
      request({ authorization: `Bearer ${'x'.repeat(40)}` }),
      'requests:read',
    );

    expect(result).toMatchObject({ ok: false, status: 401, error: 'unauthorized' });
    expect(redisEvalMock).not.toHaveBeenCalled();
  });

  it('erzwingt den Scope der Route', async () => {
    const result = await authenticateN8nCallback(request(), 'research:write');

    expect(result).toMatchObject({ ok: false, status: 403, error: 'forbidden' });
    expect(redisEvalMock).not.toHaveBeenCalled();
  });

  it('verlangt eine sichere x-taxtronik-request-id', async () => {
    const result = await authenticateN8nCallback(
      request({ 'x-taxtronik-request-id': 'contains spaces' }),
      'requests:read',
    );

    expect(result).toMatchObject({ ok: false, status: 400, error: 'invalid_request' });
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it('weist deaktivierte Connections generisch zurueck', async () => {
    findUniqueMock.mockResolvedValue({
      id: CONNECTION_ID,
      tenantId: TENANT_ID,
      enabled: false,
      callbackTokenHash: createHash('sha256').update(TOKEN).digest('hex'),
      callbackScopes: ['requests:read'],
    });

    expect(await authenticateN8nCallback(request(), 'requests:read')).toMatchObject({
      ok: false,
      status: 401,
      error: 'unauthorized',
    });
  });

  it('behandelt einen korrupten gespeicherten Hash als Auth-Fehler', async () => {
    findUniqueMock.mockResolvedValue({
      id: CONNECTION_ID,
      tenantId: TENANT_ID,
      enabled: true,
      callbackTokenHash: 'not-a-sha256-hash',
      callbackScopes: ['requests:read'],
    });

    expect(await authenticateN8nCallback(request(), 'requests:read')).toMatchObject({
      ok: false,
      status: 401,
      error: 'unauthorized',
    });
  });

  it('akzeptiert die Single-Header-Form "Bearer <keyId>.<token>" ohne Key-ID-Header', async () => {
    const req = new NextRequest('http://localhost/api/integrations/n8n/v1/overdue-requests', {
      headers: {
        authorization: `Bearer ${KEY_ID}.${TOKEN}`,
        'x-taxtronik-request-id': 'n8n-execution-42',
      },
    });

    const result = await authenticateN8nCallback(req, 'requests:read');

    expect(result).toMatchObject({ ok: true, connectionId: CONNECTION_ID, tenantId: TENANT_ID });
    expect(findUniqueMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { callbackKeyId: KEY_ID } }),
    );
  });

  it('weist die Single-Header-Form mit falschem Token zurueck', async () => {
    const req = new NextRequest('http://localhost/api/integrations/n8n/v1/overdue-requests', {
      headers: {
        authorization: `Bearer ${KEY_ID}.${'x'.repeat(40)}`,
        'x-taxtronik-request-id': 'n8n-execution-42',
      },
    });

    expect(await authenticateN8nCallback(req, 'requests:read')).toMatchObject({
      ok: false,
      status: 401,
      error: 'unauthorized',
    });
  });

  it('laesst einen explizit gesetzten Key-ID-Header Vorrang vor der eingebetteten Key-ID', async () => {
    // Ein gesetzter (aber anderer) Key-ID-Header darf nicht still durch die im
    // Token eingebettete UUID ersetzt werden.
    const otherKeyId = randomUUID();
    findUniqueMock.mockResolvedValue(null);
    const req = request({
      authorization: `Bearer ${KEY_ID}.${TOKEN}`,
      'x-taxtronik-key-id': otherKeyId,
    });

    expect(await authenticateN8nCallback(req, 'requests:read')).toMatchObject({
      ok: false,
      status: 401,
    });
    expect(findUniqueMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { callbackKeyId: otherKeyId } }),
    );
  });

  it('weist ein Bearer-Token ohne Key-ID (weder Header noch eingebettet) zurueck', async () => {
    const req = new NextRequest('http://localhost/api/integrations/n8n/v1/overdue-requests', {
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'x-taxtronik-request-id': 'n8n-execution-42',
      },
    });

    expect(await authenticateN8nCallback(req, 'requests:read')).toMatchObject({
      ok: false,
      status: 401,
      error: 'unauthorized',
    });
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it('meldet einen fehlgeschlagenen Connection-Lookup als retrybar', async () => {
    findUniqueMock.mockRejectedValue(new Error('database down'));

    expect(await authenticateN8nCallback(request(), 'requests:read')).toMatchObject({
      ok: false,
      status: 503,
      error: 'unavailable',
    });
  });
});

describe('runReservedN8nCallback', () => {
  it('reserviert atomar erst unmittelbar vor der Operation und behaelt erfolgreiche IDs', async () => {
    const auth = await authenticated();
    const operation = vi.fn(async () => {
      expect(redisEvalMock).toHaveBeenCalledTimes(1);
      return NextResponse.json({ ok: true });
    });

    const response = await runReservedN8nCallback(auth, operation);

    expect(response.status).toBe(200);
    expect(redisEvalMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("'IN_PROGRESS:' .. ARGV[1]"),
      1,
      expect.stringMatching(new RegExp(`^n8n-callback:${CONNECTION_ID}:[a-f0-9]{64}$`)),
      expect.any(String),
      '900',
    );
    expect(redisEvalMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("redis.call('SET', KEYS[1], 'COMPLETED'"),
      1,
      expect.stringMatching(/^n8n-callback:/),
      expect.any(String),
      '604800',
    );
  });

  it('blockiert parallele Duplikate, waehrend die erste Operation laeuft', async () => {
    const auth = await authenticated();
    redisEvalMock.mockResolvedValueOnce(1).mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    let finishFirst!: (response: NextResponse) => void;
    const first = runReservedN8nCallback(
      auth,
      () => new Promise<NextResponse>((resolve) => (finishFirst = resolve)),
    );
    await vi.waitFor(() => expect(redisEvalMock).toHaveBeenCalledTimes(1));

    const duplicateOperation = vi.fn(async () => NextResponse.json({ ok: true }));
    const duplicate = await runReservedN8nCallback(auth, duplicateOperation);

    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: 'duplicate_request' });
    expect(duplicate.headers.get('retry-after')).toBe('5');
    expect(duplicateOperation).not.toHaveBeenCalled();
    finishFirst(NextResponse.json({ ok: true }));
    expect((await first).status).toBe(200);
  });

  it('schliesst bei fehlendem oder fehlerhaftem Redis fail-closed', async () => {
    const auth = await authenticated();
    const operation = vi.fn(async () => NextResponse.json({ ok: true }));
    getRedisMock.mockReturnValueOnce(null);
    expect(await runReservedN8nCallback(auth, operation)).toMatchObject({ status: 503 });

    getRedisMock.mockReturnValueOnce({
      eval: vi.fn().mockRejectedValue(new Error('down')),
    });
    expect(await runReservedN8nCallback(auth, operation)).toMatchObject({ status: 503 });
    expect(operation).not.toHaveBeenCalled();
  });

  it('gibt die eigene Reservation bei einer 5xx-Antwort compare-and-delete frei', async () => {
    const auth = await authenticated();
    const response = await runReservedN8nCallback(auth, async () =>
      NextResponse.json({ error: 'write_failed' }, { status: 503 }),
    );

    expect(response.status).toBe(503);
    const owner = redisEvalMock.mock.calls[0]?.[3];
    expect(redisEvalMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("== 'IN_PROGRESS:' .. ARGV[1]"),
      1,
      expect.stringMatching(/^n8n-callback:/),
      owner,
    );
  });

  it('gibt die eigene Reservation auch bei einem geworfenen Write-Fehler frei', async () => {
    const auth = await authenticated();

    await expect(
      runReservedN8nCallback(auth, async () => {
        throw new Error('transaction rolled back');
      }),
    ).rejects.toThrow('transaction rolled back');
    expect(redisEvalMock).toHaveBeenCalledTimes(2);
  });

  it('liefert fuer einen DB-bestaetigten abgeschlossenen Write-Replay idempotent 2xx', async () => {
    const auth = await authenticated();
    redisEvalMock.mockResolvedValueOnce(2);
    const operation = vi.fn(async () => NextResponse.json({ ok: true }));

    const response = await runReservedN8nCallback(auth, operation, {
      onReplay: () => NextResponse.json({ ok: true, duplicate: true }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, duplicate: true });
    expect(operation).not.toHaveBeenCalled();
  });

  it('kann einen nach DB-Commit verbliebenen IN_PROGRESS-Marker als 2xx bestaetigen', async () => {
    const auth = await authenticated();
    redisEvalMock.mockResolvedValueOnce(0);
    const operation = vi.fn(async () => NextResponse.json({ ok: true }));

    const response = await runReservedN8nCallback(auth, operation, {
      onReplay: (state) =>
        state === 'in_progress' ? NextResponse.json({ ok: true, duplicate: true }) : null,
    });

    expect(response.status).toBe(200);
    expect(operation).not.toHaveBeenCalled();
  });

  it('behandelt einen abgeschlossenen Read ohne Write-Option weiter als Duplikat', async () => {
    const auth = await authenticated();
    redisEvalMock.mockResolvedValueOnce(2);
    const operation = vi.fn(async () => NextResponse.json({ ok: true }));

    const response = await runReservedN8nCallback(auth, operation);

    expect(response.status).toBe(409);
    expect(response.headers.get('retry-after')).toBe('5');
    expect(operation).not.toHaveBeenCalled();
  });

  it('gibt eine fachlich fehlgeschlagene Write-Operation ebenfalls frei', async () => {
    const auth = await authenticated();

    const response = await runReservedN8nCallback(auth, async () =>
      NextResponse.json({ error: 'not_assignable' }, { status: 422 }),
    );

    expect(response.status).toBe(422);
    expect(redisEvalMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("== 'IN_PROGRESS:' .. ARGV[1]"),
      1,
      expect.stringMatching(/^n8n-callback:/),
      expect.any(String),
    );
  });
});
