import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@taxtronik/config';
import { withTenantContext } from '@taxtronik/db';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { evidenceService } from '@/server/container';
import { assertSameOrigin } from '@/server/http/assert-same-origin';
import { getClientIp, checkStaffExportLimit } from '@/server/rate-limit';
import { runBackup, type BackupResult } from '@/server/backup/runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

let runningBackup: Promise<BackupResult> | null = null;

export async function POST(req: NextRequest) {
  const csrf = assertSameOrigin(req, env.NEXTAUTH_URL);
  if (csrf) return csrf;

  const session = await staffAuth();
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isStaffAdmin(session)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const { tenantId, staffId } = session.user;
  const rl = await checkStaffExportLimit('backup-run', staffId);
  if (!rl.ok) {
    return NextResponse.json({ error: 'rate_limited', retryAfter: rl.retryAfter }, { status: 429 });
  }

  if (runningBackup) {
    return NextResponse.json({ error: 'backup_already_running' }, { status: 409 });
  }

  // Slot SOFORT (synchron) belegen — läge zwischen Check und Zuweisung ein
  // await (der Audit-Write), passieren zwei parallele Requests beide den
  // Null-Check und starten runBackup() doppelt: beide Läufe schreiben dann
  // denselben minutengenauen S3-Key/lokalen Pfad und überschreiben sich.
  runningBackup = (async (): Promise<BackupResult> => {
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
    // Ein Browser-Admin ist tenantgebunden. Der vollständige pg_dump darf
    // deshalb nur in einer nachweislichen Single-Tenant-Installation starten;
    // globale Multi-Tenant-Backups bleiben reine Betreiber-/Worker-Aufgabe.
    return runBackup({ singleTenantId: tenantId });
  })().finally(() => {
    runningBackup = null;
  });

  let result: BackupResult;
  try {
    result = await runningBackup;
  } catch (e) {
    // z. B. Audit-Write fehlgeschlagen — keine internen Details ans UI.
    console.error(`[backup] Trigger fehlgeschlagen: ${(e as Error).message}`);
    return NextResponse.json({ error: 'backup_failed' }, { status: 500 });
  }
  if (!result.ok) {
    if (result.error === 'backup_scope_not_allowed') {
      return NextResponse.json({ error: result.error }, { status: 403 });
    }
    return NextResponse.json({ error: result.error ?? 'backup_failed' }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    recordId: result.recordId,
  });
}
