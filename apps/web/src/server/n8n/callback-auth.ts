// =============================================================================
// Authentifizierung fuer versionierte n8n -> TaxTronik Callbacks.
//
// Anders als die Legacy-HMAC-Routen ist ein Callback-Key genau einer
// N8nConnection und damit genau einem Tenant zugeordnet. Ein vom Aufrufer
// gelieferter tenantId-Wert ist niemals Autoritaet fuer den Datenzugriff.
// =============================================================================

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { prismaOwner } from '@/server/db/prisma-owner';
import { log } from '@/server/logger';
import { getRedis } from '@/server/redis';

export const N8N_CALLBACK_SCOPES = [
  'requests:read',
  'gwg:read',
  'research:write',
  'inbound-mail:write',
] as const;

export type N8nCallbackScope = (typeof N8N_CALLBACK_SCOPES)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;
const CALLBACK_IN_PROGRESS_TTL_SECONDS = 15 * 60;
const CALLBACK_COMPLETED_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface N8nCallbackAuthSuccess {
  ok: true;
  connectionId: string;
  tenantId: string;
  requestId: string;
  /** Dem Credential gewaehrte Scopes (fuer den Ping-/Basis-Endpunkt). */
  scopes: string[];
}

export interface N8nCallbackAuthFailure {
  ok: false;
  status: 400 | 401 | 403 | 409 | 503;
  /** Generischer, fuer den Client bestimmter Fehlercode. */
  error: 'invalid_request' | 'unauthorized' | 'forbidden' | 'duplicate_request' | 'unavailable';
  /** Serverseitiges Diagnose-Detail; niemals ungefiltert an den Client geben. */
  reason: string;
}

export type N8nCallbackAuthResult = N8nCallbackAuthSuccess | N8nCallbackAuthFailure;

function reject(
  status: N8nCallbackAuthFailure['status'],
  error: N8nCallbackAuthFailure['error'],
  reason: string,
): N8nCallbackAuthFailure {
  return { ok: false, status, error, reason };
}

/** Einheitliche, absichtlich detailarme Callback-Fehlerantwort. */
export function n8nCallbackRejectResponse(result: N8nCallbackAuthFailure): NextResponse {
  return NextResponse.json(
    { error: result.error },
    {
      status: result.status,
      headers: result.status === 409 ? { 'Retry-After': '5' } : undefined,
    },
  );
}

function callbackReplayKey(connectionId: string, requestId: string): string {
  // Der externe Request-Identifier kann fachliche Informationen enthalten.
  // Im Redis-Key landet deshalb nur ein stabiler Hash davon.
  const digest = createHash('sha256').update(requestId, 'utf8').digest('hex');
  return `n8n-callback:${connectionId}:${digest}`;
}

interface N8nCallbackReservation {
  key: string;
  owner: string;
}

type N8nCallbackReservationResult =
  | { ok: true; state: 'acquired'; reservation: N8nCallbackReservation }
  | { ok: true; state: 'in_progress' }
  | { ok: true; state: 'completed' }
  | N8nCallbackAuthFailure;

const RESERVE_OR_INSPECT_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then
  redis.call('SET', KEYS[1], 'IN_PROGRESS:' .. ARGV[1], 'EX', ARGV[2])
  return 1
end
if current == 'COMPLETED' then
  return 2
end
return 0
`;

const RELEASE_IF_OWNED_SCRIPT = `
if redis.call('GET', KEYS[1]) == 'IN_PROGRESS:' .. ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const COMPLETE_IF_OWNED_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current == 'IN_PROGRESS:' .. ARGV[1] then
  redis.call('SET', KEYS[1], 'COMPLETED', 'EX', ARGV[2])
  return 1
end
if current == 'COMPLETED' then
  return 1
end
return 0
`;

async function reserveRequestId(
  connectionId: string,
  requestId: string,
): Promise<N8nCallbackReservationResult> {
  const redis = getRedis();
  if (!redis) {
    return reject(503, 'unavailable', 'callback replay store unavailable');
  }

  const reservation = {
    key: callbackReplayKey(connectionId, requestId),
    owner: randomUUID(),
  };

  try {
    const result = await redis.eval(
      RESERVE_OR_INSPECT_SCRIPT,
      1,
      reservation.key,
      reservation.owner,
      String(CALLBACK_IN_PROGRESS_TTL_SECONDS),
    );
    if (result === 1) {
      return { ok: true, state: 'acquired', reservation };
    }
    if (result === 2) {
      return { ok: true, state: 'completed' };
    }
    if (result === 0) {
      return { ok: true, state: 'in_progress' };
    }
    return reject(503, 'unavailable', 'callback replay store returned an invalid state');
  } catch {
    return reject(503, 'unavailable', 'callback replay store unavailable');
  }
}

async function completeRequestId(reservation: N8nCallbackReservation): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    const result = await redis.eval(
      COMPLETE_IF_OWNED_SCRIPT,
      1,
      reservation.key,
      reservation.owner,
      String(CALLBACK_COMPLETED_TTL_SECONDS),
    );
    return result === 1;
  } catch {
    return false;
  }
}

async function releaseRequestId(reservation: N8nCallbackReservation): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    const result = await redis.eval(RELEASE_IF_OWNED_SCRIPT, 1, reservation.key, reservation.owner);
    return result === 1;
  } catch {
    return false;
  }
}

/**
 * Authentifiziert einen versionierten Callback. Die Request-ID wird hier
 * bewusst noch NICHT reserviert: Query/Body muessen zuerst validiert werden.
 */
export async function authenticateN8nCallback(
  request: NextRequest,
  /** null = reiner Credential-Check ohne Scope-Anforderung (Ping-Endpunkt). */
  requiredScope: N8nCallbackScope | null,
): Promise<N8nCallbackAuthResult> {
  const callbackKeyId = request.headers.get('x-taxtronik-key-id')?.trim() ?? '';
  const authorization = request.headers.get('authorization')?.trim() ?? '';
  const requestId = request.headers.get('x-taxtronik-request-id')?.trim() ?? '';

  if (!UUID_RE.test(callbackKeyId)) {
    return reject(401, 'unauthorized', 'missing or invalid x-taxtronik-key-id');
  }

  const bearer = /^Bearer ([^\s]+)$/i.exec(authorization);
  const token = bearer?.[1] ?? '';
  if (token.length < 32 || token.length > 512) {
    return reject(401, 'unauthorized', 'missing or invalid bearer token');
  }

  // Der Ping-Endpunkt (requiredScope null) reserviert nichts — dort ist die
  // Request-ID optional, damit ein einfacher Verbindungstest ohne Extra-Header
  // moeglich ist.
  if (requiredScope !== null && !REQUEST_ID_RE.test(requestId)) {
    return reject(400, 'invalid_request', 'missing or invalid x-taxtronik-request-id');
  }

  let connection: {
    id: string;
    tenantId: string;
    enabled: boolean;
    callbackTokenHash: string | null;
    callbackScopes: string[];
  } | null;
  try {
    connection = await prismaOwner.n8nConnection.findUnique({
      where: { callbackKeyId },
      select: {
        id: true,
        tenantId: true,
        enabled: true,
        callbackTokenHash: true,
        callbackScopes: true,
      },
    });
  } catch {
    return reject(503, 'unavailable', 'callback connection lookup failed');
  }

  if (!connection?.enabled) {
    return reject(401, 'unauthorized', 'callback connection not found or disabled');
  }

  const candidateHash = createHash('sha256').update(token, 'utf8').digest();
  const storedHashIsValid = SHA256_HEX_RE.test(connection.callbackTokenHash ?? '');
  // timingSafeEqual verlangt gleich lange Buffer. Auch bei einem korrupten
  // gespeicherten Hash fuehren wir genau einen 32-Byte-Vergleich aus.
  const storedHash = storedHashIsValid
    ? Buffer.from(connection.callbackTokenHash!, 'hex')
    : Buffer.alloc(candidateHash.length);
  const tokenMatches = timingSafeEqual(candidateHash, storedHash);
  if (!storedHashIsValid || !tokenMatches) {
    return reject(401, 'unauthorized', 'callback token mismatch');
  }

  if (requiredScope !== null && !connection.callbackScopes.includes(requiredScope)) {
    return reject(403, 'forbidden', `missing callback scope: ${requiredScope}`);
  }

  return {
    ok: true,
    connectionId: connection.id,
    tenantId: connection.tenantId,
    requestId,
    scopes: [...connection.callbackScopes],
  };
}

/**
 * Reserviert die bereits validierte Callback-Request-ID unmittelbar vor der
 * Datenbankoperation. Bei Exceptions oder nicht erfolgreichen Antworten wird
 * nur die von dieser Ausfuehrung gehaltene Reservation atomar freigegeben.
 * Erfolgreiche Antworten wechseln in den langlebigen COMPLETED-Zustand.
 */
export async function runReservedN8nCallback(
  auth: N8nCallbackAuthSuccess,
  operation: () => Promise<NextResponse>,
  options: {
    onReplay?: (
      state: 'in_progress' | 'completed',
    ) => NextResponse | null | Promise<NextResponse | null>;
  } = {},
): Promise<NextResponse> {
  const reserved = await reserveRequestId(auth.connectionId, auth.requestId);
  if (!reserved.ok) return n8nCallbackRejectResponse(reserved);
  if (reserved.state !== 'acquired') {
    const replay = await options.onReplay?.(reserved.state);
    if (replay) return replay;
    return n8nCallbackRejectResponse(
      reject(409, 'duplicate_request', `callback request id is ${reserved.state}`),
    );
  }

  try {
    const response = await operation();
    if (response.status >= 200 && response.status < 300) {
      const completed = await completeRequestId(reserved.reservation);
      if (!completed) {
        log.error(
          { component: 'n8n-callback', connectionId: auth.connectionId },
          'callback succeeded but completion marker could not be persisted',
        );
      }
    } else {
      const released = await releaseRequestId(reserved.reservation);
      if (!released) {
        log.error(
          { component: 'n8n-callback', connectionId: auth.connectionId },
          'failed callback reservation could not be released',
        );
      }
    }
    return response;
  } catch (error) {
    const released = await releaseRequestId(reserved.reservation);
    if (!released) {
      log.error(
        { component: 'n8n-callback', connectionId: auth.connectionId },
        'thrown callback reservation could not be released',
      );
    }
    throw error;
  }
}
