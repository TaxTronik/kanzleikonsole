// =============================================================================
// GET /api/health/detail
//
// Admin-gated Detail-Variante von /api/health. Liefert interne Fehlertexte,
// Latenzen und Service-Endpoints — Informationen, die ein unauthentifizierter
// Anrufer nicht sehen darf (N3).
//
// Auth: ADMIN/PARTNER. Reverse-Proxy/K8s nutzt weiter /api/health (Public).
//
// B14 (P-17): `maintenance` meldet je Wartungsjob (audit-rotate,
// storage-orphan-cleanup) den Rückstand des letzten erfolgreichen Laufs —
// Anzahl, Fälligkeit und Alter des ältesten offenen Eintrags, Läufe in Folge,
// Alarm und Schwelle — ohne Tenant-Bezug. Ein Rückstand ist kein Dienstausfall:
// `status`/HTTP-Code bleiben bei den Diensten, `maintenance.status` meldet
// `alarm`, solange ein Job über der Schwelle liegt.
// =============================================================================

import { NextResponse } from 'next/server';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import {
  checkPostgres,
  checkRedis,
  checkObjectStore,
  checkClamAV,
  checkSignalEngine,
  type ServiceStatus,
} from '@/server/health/checks';
import { readModules } from '@/server/settings/modules';
import { getMaintenanceBacklogHealth } from '@/server/jobs/maintenance-backlog';

export async function GET() {
  const session = await staffAuth();
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isStaffAdmin(session)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const { tenantId, staffId } = session.user;

  const [postgres, redis, objectStore, clamav, modules, signalRaw, maintenance] = await Promise.all(
    [
      checkPostgres(),
      checkRedis(),
      checkObjectStore(),
      checkClamAV(),
      readModules({ tenantId, actorId: staffId, actorType: 'STAFF' }),
      checkSignalEngine(),
      getMaintenanceBacklogHealth(),
    ],
  );

  const services: Record<string, ServiceStatus> = { postgres, redis, objectStore, clamav };
  // Signal-Engine nur aufnehmen, wenn das Modul aktiv UND die Engine konfiguriert
  // ist (signalRaw === null → nicht konfiguriert → auslassen, kein Degraded).
  if (modules.signalEngine && signalRaw) services.signalEngine = signalRaw;

  const allOk = Object.values(services).every((s) => s.ok);
  return NextResponse.json(
    {
      status: allOk ? 'ok' : 'degraded',
      services,
      maintenance,
      // APP_VERSION kommt aus Compose (TAXTRONIK_VERSION) bzw. dem Image-Build,
      // GIT_SHA backt der Release-Workflow ins Image — beantwortet "welcher
      // Stand läuft hier gerade?" ohne SSH auf den Server.
      version: {
        app: process.env['APP_VERSION'] ?? 'dev',
        commit: process.env['GIT_SHA'] ?? 'unknown',
      },
      timestamp: new Date().toISOString(),
    },
    { status: allOk ? 200 : 503 },
  );
}
