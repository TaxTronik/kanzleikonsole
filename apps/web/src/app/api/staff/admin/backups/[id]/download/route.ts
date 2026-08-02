import { NextResponse, type NextRequest } from 'next/server';
import { withTenantContext } from '@taxtronik/db';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { evidenceService } from '@/server/container';
import { getClientIp, checkStaffBackupDownloadLimit } from '@/server/rate-limit';
import { isUuid } from '@/lib/uuid';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await staffAuth();
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isStaffAdmin(session)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const { id } = await params;
  // Prisma wirft bei Nicht-UUID P2023 → 500 statt 404. Wie in der
  // Portal-Schwesterroute vorab abweisen.
  if (!isUuid(id)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  const source = req.nextUrl.searchParams.get('source') ?? 'auto';
  if (source !== 'auto' && source !== 'local' && source !== 's3') {
    return NextResponse.json({ error: 'invalid_source' }, { status: 400 });
  }

  const rl = await checkStaffBackupDownloadLimit(staffId, source);
  if (!rl.ok) {
    return NextResponse.json({ error: 'rate_limited', retryAfter: rl.retryAfter }, { status: 429 });
  }

  const rec = await withTenantContext(ctx, (tx) =>
    tx.backupRecord.findFirst({
      where: { id, tenantId, status: 'SUCCESS' },
      select: { id: true },
    }),
  );

  if (!rec) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  await withTenantContext(ctx, (tx) =>
    evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'backup.download_denied',
      resourceType: 'backup_record',
      resourceId: rec.id,
      ip: getClientIp(req.headers),
      userAgent: req.headers.get('user-agent'),
      after: { source, reason: 'operator_only_full_database_dump' },
    }),
  );

  // BackupRecord referenziert einen vollständigen pg_dump mit globalen und
  // potenziell tenantübergreifenden Sicherheitsdaten. Ein Tenant-Login darf
  // ihn daher auch in einer aktuell reinen Single-Tenant-Installation niemals
  // herunterladen; Zugriff erfolgt ausschließlich über den Betreiber-Host/S3.
  return NextResponse.json({ error: 'backup_download_operator_only' }, { status: 403 });
}
