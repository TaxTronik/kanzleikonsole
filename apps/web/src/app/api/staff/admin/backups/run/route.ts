import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@taxtronik/config';
import { withTenantContext } from '@taxtronik/db';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { evidenceService } from '@/server/container';
import { prismaOwner } from '@/server/db/prisma-owner';
import { assertSameOrigin } from '@/server/http/assert-same-origin';
import { getClientIp, checkStaffExportLimit } from '@/server/rate-limit';
import { matchesSingleTenantBackupScope } from '@/server/backup/scope';
import {
  BACKUP_RUNNING_STALE_MS,
  enqueueManualBackup,
  getManualBackupJobState,
  isPendingBackupJobState,
} from '@/server/jobs/backup-run-queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// P-22: Der Request startet kein pg_dump mehr. Er reiht den Worker-Job
// backup-run ein (202) und die Admin-Übersicht fragt den Zustand per GET ab.
// Doppelstarts verhindern Queue (feste jobId) und Datenbank (RUNNING-Record).

async function adminSession() {
  const session = await staffAuth();
  if (!session?.user) {
    return { error: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) };
  }
  if (!isStaffAdmin(session)) {
    return { error: NextResponse.json({ error: 'forbidden' }, { status: 403 }) };
  }
  return { session };
}

function latestBackupTx(tenantId: string, staffId: string) {
  return withTenantContext({ tenantId, actorId: staffId, actorType: 'STAFF' }, (tx) =>
    tx.backupRecord.findFirst({
      orderBy: { startedAt: 'desc' },
      select: { id: true, status: true, startedAt: true, finishedAt: true },
    }),
  );
}

export async function POST(req: NextRequest) {
  const csrf = assertSameOrigin(req, env.NEXTAUTH_URL);
  if (csrf) return csrf;

  const auth = await adminSession();
  if (auth.error) return auth.error;
  const { tenantId, staffId } = auth.session.user;

  const rl = await checkStaffExportLimit('backup-run', staffId);
  if (!rl.ok) {
    return NextResponse.json({ error: 'rate_limited', retryAfter: rl.retryAfter }, { status: 429 });
  }

  try {
    // Ein Browser-Admin ist tenantgebunden. Der vollständige pg_dump darf
    // deshalb nur in einer nachweislichen Single-Tenant-Installation starten;
    // globale Multi-Tenant-Backups bleiben reine Betreiber-/Worker-Aufgabe.
    const tenants = await prismaOwner.tenant.findMany({ select: { id: true } });
    if (
      !matchesSingleTenantBackupScope(
        tenants.map((tenant) => tenant.id),
        tenantId,
      )
    ) {
      return NextResponse.json({ error: 'backup_scope_not_allowed' }, { status: 403 });
    }

    const latest = await latestBackupTx(tenantId, staffId);
    if (
      isPendingBackupJobState(await getManualBackupJobState(tenantId)) ||
      (latest?.status === 'RUNNING' &&
        Date.now() - latest.startedAt.getTime() < BACKUP_RUNNING_STALE_MS)
    ) {
      return NextResponse.json({ error: 'backup_already_running' }, { status: 409 });
    }

    await withTenantContext({ tenantId, actorId: staffId, actorType: 'STAFF' }, (tx) =>
      evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'backup.trigger',
        resourceType: 'tenant',
        resourceId: tenantId,
        ip: getClientIp(req.headers),
        userAgent: req.headers.get('user-agent'),
        after: { source: 'admin-browser' },
      }),
    );
    if (!(await enqueueManualBackup(tenantId, staffId))) {
      return NextResponse.json({ error: 'backup_already_running' }, { status: 409 });
    }
  } catch (e) {
    // z. B. Audit-Write oder Redis fehlgeschlagen — keine internen Details ans UI.
    console.error(`[backup] Trigger fehlgeschlagen: ${(e as Error).message}`);
    return NextResponse.json({ error: 'backup_failed' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, queued: true }, { status: 202 });
}

/** Zustand für die Abfrage des Buttons: Job in der Queue + letzter BackupRecord. */
export async function GET() {
  const auth = await adminSession();
  if (auth.error) return auth.error;
  const { tenantId, staffId } = auth.session.user;

  try {
    const [job, latest] = await Promise.all([
      getManualBackupJobState(tenantId),
      latestBackupTx(tenantId, staffId),
    ]);
    return NextResponse.json(
      {
        job,
        latest: latest
          ? {
              id: latest.id,
              status: latest.status,
              startedAt: latest.startedAt.toISOString(),
              finishedAt: latest.finishedAt?.toISOString() ?? null,
            }
          : null,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    console.error(`[backup] Statusabfrage fehlgeschlagen: ${(e as Error).message}`);
    return NextResponse.json({ error: 'backup_status_unavailable' }, { status: 503 });
  }
}
