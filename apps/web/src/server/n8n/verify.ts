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
import type { NextRequest } from 'next/server';
import { env } from '@taxtronik/config';
import { consumeNonce } from './nonce-store';

const REPLAY_WINDOW_MS = 5 * 60 * 1000;

export interface VerifyResult {
  ok: boolean;
  body?: string;
  error?: string;
  /** Bei `ok=false` HTTP-Status, den der Caller zurückgeben sollte. */
  status?: number;
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

  // Replay-Schutz: Signatur als Nonce reservieren. Bei nicht erreichbarem
  // Redis fail-closed (503) — Security darf nicht stillschweigend kippen.
  const consumed = await consumeNonce(provided);
  if (consumed === null) {
    return { ok: false, error: 'replay-store unavailable', status: 503 };
  }
  if (!consumed) {
    return { ok: false, error: 'replay detected', status: 401 };
  }

  return { ok: true, body };
}
