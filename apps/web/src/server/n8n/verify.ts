// =============================================================================
// HMAC-Verifikation für eingehende n8n-Calls
//
// Vereinheitlicht für POST (mit Body) und GET (Body = leer).
// Header: x-taxtronik-signature: sha256=<hex(hmac(method+path+search+ts+body, secret))>
//         x-taxtronik-timestamp: <epoch-ms> (innerhalb ±5min)
//
// Replay-Schutz (S3): Timestamp muss im Fenster sein, Signatur wird nach
// erfolgreicher Validierung als Nonce in Redis gespeichert. Ein zweiter
// Aufruf mit derselben Signatur wird abgewiesen.
//
// Der Path enthält method + nextUrl.pathname + nextUrl.search — so wird auch
// der Query-String mitsigniert (verhindert Parameter-Manipulation).
// =============================================================================

import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@taxtronik/config';
import { releaseNonce, reserveNonce } from './nonce-store';

const REPLAY_WINDOW_MS = 5 * 60 * 1000;

export interface VerifySuccess {
  ok: true;
  body: string;
  replayId: string;
}

export interface VerifyFailure {
  ok: false;
  error: string;
  /** Bei `ok=false` HTTP-Status, den der Caller zurückgeben sollte. */
  status: number;
}

export type VerifyResult = VerifySuccess | VerifyFailure;

/**
 * Befund 10: Einheitliche Reject-Response für fehlgeschlagene
 * verifyN8nSignature-Checks. Vorher mappte jede Route selbst — drei von vier
 * gaben pauschal 401 zurück und maskierten damit den Redis-Ausfall (503,
 * für n8n retrybar) als Auth-Fehler. 503 (Replay-Store down) und 500
 * (Fehlkonfiguration) werden durchgereicht; alles andere ist ein Auth-Fehler
 * → generisches 401 ohne Detail-Leak (Audit Round 14, Finding 2 — kein
 * Side-Channel über Schlüssel-/Zeit-/Replay-Status). Details loggt der Caller.
 */
export function n8nRejectResponse(ver: VerifyFailure): NextResponse {
  const status = ver.status === 503 || ver.status === 500 ? ver.status : 401;
  return NextResponse.json({ error: status === 401 ? 'unauthorized' : 'unavailable' }, { status });
}

export async function verifyN8nSignature(req: NextRequest): Promise<VerifyResult> {
  const secret = env.N8N_HMAC_SECRET;
  if (!secret) {
    return { ok: false, error: 'N8N_HMAC_SECRET not configured', status: 500 };
  }

  const provided = req.headers.get('x-taxtronik-signature');
  if (!provided) {
    return { ok: false, error: 'missing x-taxtronik-signature header', status: 401 };
  }

  const tsHeader = req.headers.get('x-taxtronik-timestamp');
  if (!tsHeader) {
    return { ok: false, error: 'missing x-taxtronik-timestamp header', status: 401 };
  }
  const ts = Number(tsHeader);
  if (!Number.isFinite(ts)) {
    return { ok: false, error: 'invalid timestamp', status: 401 };
  }
  const drift = Math.abs(Date.now() - ts);
  if (drift > REPLAY_WINDOW_MS) {
    return { ok: false, error: 'timestamp outside replay window', status: 401 };
  }

  const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.text();
  const payload = `${req.method} ${req.nextUrl.pathname}${req.nextUrl.search}\n${ts}\n${body}`;
  const expectedHex = createHmac('sha256', secret).update(payload).digest('hex');
  const expected = `sha256=${expectedHex}`;

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    return { ok: false, error: 'signature length mismatch', status: 401 };
  }
  if (!timingSafeEqual(a, b)) {
    return { ok: false, error: 'signature mismatch', status: 401 };
  }

  // Die Replay-ID wird absichtlich erst nach Query-/Body-Validierung durch
  // runReservedN8nRequest reserviert. So verbraucht ein korrigierbarer 400er
  // keine Nonce, während parallele gültige Aufrufe atomar blockiert bleiben.
  return { ok: true, body, replayId: provided };
}

/**
 * Reserviert den verifizierten Legacy-Request unmittelbar vor der Operation.
 * Erfolgreiche Antworten behalten die Nonce. Bei Exceptions oder nicht
 * erfolgreichen Antworten wird sie owner-sicher freigegeben und kann erneut
 * zugestellt werden.
 */
export async function runReservedN8nRequest(
  verification: VerifySuccess,
  operation: () => Promise<NextResponse>,
): Promise<NextResponse> {
  const reservation = await reserveNonce(verification.replayId);
  if (reservation === null) {
    return n8nRejectResponse({
      ok: false,
      error: 'replay-store unavailable',
      status: 503,
    });
  }
  if (!reservation) {
    return n8nRejectResponse({ ok: false, error: 'replay detected', status: 401 });
  }

  try {
    const response = await operation();
    if (response.status < 200 || response.status >= 300) await releaseNonce(reservation);
    return response;
  } catch (error) {
    await releaseNonce(reservation);
    throw error;
  }
}
