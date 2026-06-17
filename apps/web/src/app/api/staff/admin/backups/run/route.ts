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

  await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) =>
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

  runningBackup = runBackup().finally(() => {
    runningBackup = null;
  });

  const result = await runningBackup;
  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? 'backup_failed' }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    recordId: result.recordId,
    sizeBytes: result.sizeBytes,
    bucket: result.bucket,
    key: result.key,
    sha256: result.sha256,
    localPath: result.localPath,
  });
}
