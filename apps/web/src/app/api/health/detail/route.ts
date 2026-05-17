// =============================================================================
// GET /api/health/detail
//
// Admin-gated Detail-Variante von /api/health. Liefert interne Fehlertexte,
// Latenzen und Service-Endpoints — Informationen, die ein unauthentifizierter
// Anrufer nicht sehen darf (N3).
//
// Auth: ADMIN/PARTNER. Reverse-Proxy/K8s nutzt weiter /api/health (Public).
// =============================================================================

import { NextResponse } from 'next/server';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import {
  checkPostgres,
  checkRedis,
  checkObjectStore,
  checkClamAV,
} from '@/server/health/checks';

export async function GET() {
  const session = await staffAuth();
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isStaffAdmin(session)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const [postgres, redis, objectStore, clamav] = await Promise.all([
    checkPostgres(),
    checkRedis(),
    checkObjectStore(),
    checkClamAV(),
  ]);

  const allOk = postgres.ok && redis.ok && objectStore.ok && clamav.ok;
  return NextResponse.json(
    {
      status: allOk ? 'ok' : 'degraded',
      services: { postgres, redis, objectStore, clamav },
      timestamp: new Date().toISOString(),
    },
    { status: allOk ? 200 : 503 },
  );
}
