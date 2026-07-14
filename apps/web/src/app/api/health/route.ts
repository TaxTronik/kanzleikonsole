// =============================================================================
// GET /api/health
//
// Public-Endpoint für Reverse-Proxy/K8s-Liveness-Probes. Liefert nur einen
// binären Status — keine internen Hostnamen, Ports oder Fehlertexte (N3).
//
// Detail-Diagnose ist Admin-only: GET /api/health/detail (gated via staffAuth
// + ADMIN/PARTNER). Dort sind die `error`-Felder der Sub-Checks sichtbar.
//
// V-2: Cached statt jedem Request. Vorher: jeder Aufruf triggerte 4 Backend-
// Operationen (DB-Connection-Slot, Redis-PING, S3-ListBuckets, ClamAV-TCP).
// Anonymer DoS mit 100 req/s = 400 ops/s — Prisma-Pool (10 Conn-Default)
// sättigt sich in Sekunden, legitime Requests warten.
//
// Strategie: 5-Sekunden-Memo-Cache. Container-Liveness (Docker/K8s prüft alle
// 30 s) bekommt damit höchstens einmal pro 5 s einen frischen Lauf, alle
// anderen Aufrufer lesen das letzte Ergebnis.
// =============================================================================

import { NextResponse } from 'next/server';
import { checkPostgres, checkRedis, checkObjectStore, checkClamAV } from '@/server/health/checks';

const CACHE_TTL_MS = 5_000;

interface CachedHealth {
  expires: number;
  payload: { status: 'ok' | 'degraded'; timestamp: string };
  httpStatus: 200 | 503;
}

// In-process-Memo — überlebt nur die Worker-Lifetime, was für Container-
// Liveness-Probes genau richtig ist (ein neuer Process startet mit frischem
// Cache und macht direkt einen echten Check).
let cache: CachedHealth | null = null;
let inflight: Promise<CachedHealth> | null = null;

async function computeHealth(): Promise<CachedHealth> {
  const [postgres, redis, objectStore, clamav] = await Promise.all([
    checkPostgres(),
    checkRedis(),
    checkObjectStore(),
    checkClamAV(),
  ]);
  const allOk = postgres.ok && redis.ok && objectStore.ok && clamav.ok;
  return {
    expires: Date.now() + CACHE_TTL_MS,
    payload: {
      status: allOk ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
    },
    httpStatus: allOk ? 200 : 503,
  };
}

export async function GET() {
  if (cache && cache.expires > Date.now()) {
    return NextResponse.json(cache.payload, {
      status: cache.httpStatus,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  // Single-flight: parallele Requests warten alle auf denselben compute-Lauf,
  // statt jeweils einen neuen zu starten. Verhindert auch unter Last den
  // Backend-Hammer.
  if (!inflight) {
    inflight = computeHealth().finally(() => {
      inflight = null;
    });
  }
  const fresh = await inflight;
  cache = fresh;
  return NextResponse.json(fresh.payload, {
    status: fresh.httpStatus,
    headers: { 'Cache-Control': 'no-store' },
  });
}
