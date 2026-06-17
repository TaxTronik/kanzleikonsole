import { NextResponse, type NextRequest } from 'next/server';
import { getClientIp } from '@/server/rate-limit';
import { staffAuth } from '@/server/auth/staff';
import { canAccessClientTx } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { streamObject, sanitizeFilenameForHeader } from '@taxtronik/storage';
import { effectiveDocumentMime, filenameWithExtension } from '@/server/storage/preview-mime';
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
        // deletedAt: null — soft-gelöschte Dokumente sind nicht mehr abrufbar
        // (auch nicht per direkter URL). Wiederherstellung läuft separat.
        where: { id, tenantId, deletedAt: null },
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

      // Zugriffsmodell (vertraulich-Flag / RESTRICTED): mandantengebundene
      // Dokumente nur, wenn der Mitarbeiter den Mandanten sehen darf.
      // clientId = null → allgemeines Kanzlei-Dokument, kein Check.
      // Verweigerung → null → 404 (kein Existenz-Leak), VOR dem Audit-Eintrag.
      if (d.clientId && !(await canAccessClientTx(tx, session, d.clientId))) return null;

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

      const isPoaDocument = await tx.powerOfAttorney.findFirst({
        where: { tenantId, documentId: d.id },
        select: { id: true },
      });

      return {
        title: d.title,
        mimeType: d.mimeType,
        classification: d.classification,
        isPoaDocument: !!isPoaDocument,
        bucket: version.storageBucket,
        key: version.storageKey,
      };
    },
  );

  if (!doc) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // App-proxied: Bytes intern aus SeaweedFS holen und direkt durchstreamen
  // (O(1)-Speicher). Der Object-Store ist nie öffentlich erreichbar.
  const obj = await streamObject(doc.bucket, doc.key);
  // Content-Type aus der DB (doc.mimeType) — zuverlässig der beim Upload
  // validierte Wert. obj.contentType von SeaweedFS ist oft ein generisches
  // 'application/octet-stream' (wenn beim PUT kein ContentType gesetzt wurde)
  // und würde den echten Typ verdecken (z. B. PDF-Download als octet-stream).
  const contentType = effectiveDocumentMime(doc);
  const headers: Record<string, string> = {
    'content-type': contentType,
    'content-disposition': `attachment; filename="${sanitizeFilenameForHeader(filenameWithExtension(doc.title, contentType))}"`,
    'cache-control': 'private, no-store',
  };
  if (obj.contentLength !== null) headers['content-length'] = String(obj.contentLength);
  return new NextResponse(obj.body, { status: 200, headers });
}
