import { NextResponse, type NextRequest } from 'next/server';
import { getClientIp } from '@/server/rate-limit';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { fetchObjectBytes, sanitizeFilenameForHeader } from '@taxtronik/storage';
import { filenameWithExtension } from '@/server/storage/preview-mime';
import { evidenceService } from '@/server/container';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await staffAuth();
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const { tenantId, staffId } = session.user;

  const doc = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      // Audit 4: Defense-in-Depth — expliziter Tenant-Filter zusätzlich zu
      // RLS. Wenn der RLS-Schutz durch eine Migrations-Drift mal kaputtgeht
      // (Policy droppen ohne Recreate), würde `findUnique({ id })` ohne
      // weiteren Filter sofort Cross-Tenant-Reads zulassen. `findFirst`
      // mit `tenantId` schließt das.
      const d = await tx.document.findFirst({
        where: { id, tenantId },
        include: {
          versions: {
            orderBy: { versionNo: 'desc' },
            take: 1,
          },
        },
      });
      if (!d) return null;
      const version = d.versions[0];
      if (!version) return null;

      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'document.download',
        resourceType: 'document',
        resourceId: id,
        ip: getClientIp(req.headers),
        userAgent: req.headers.get('user-agent'),
      });

      return {
        title: d.title,
        mimeType: d.mimeType,
        bucket: version.storageBucket,
        key: version.storageKey,
      };
    },
  );

  if (!doc) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // App-proxied: Bytes intern aus SeaweedFS holen und durchstreamen.
  // Der Object-Store ist nie öffentlich erreichbar.
  const bytes = await fetchObjectBytes(doc.bucket, doc.key);
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'content-type': doc.mimeType || 'application/octet-stream',
      'content-disposition': `attachment; filename="${sanitizeFilenameForHeader(filenameWithExtension(doc.title, doc.mimeType))}"`,
      'content-length': String(bytes.length),
      'cache-control': 'private, no-store',
    },
  });
}
