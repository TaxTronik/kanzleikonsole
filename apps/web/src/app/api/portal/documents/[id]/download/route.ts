import { NextResponse, type NextRequest } from 'next/server';
import { getClientIp, checkPortalReadLimit } from '@/server/rate-limit';
import { portalAuth } from '@/server/auth/portal';
import { withTenantContext } from '@taxtronik/db';
import { streamObject, sanitizeFilenameForHeader } from '@taxtronik/storage';
import { effectiveDocumentMime, filenameWithExtension } from '@/server/storage/preview-mime';
import { evidenceService } from '@/server/container';
import { isUuid } from '@/lib/uuid';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await portalAuth();
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const { tenantId, contactId, clientId } = session.user;

  // Audit 2026-06 Befund 6: Read-Limit pro Session-Kontakt — deckelt
  // Audit-Spam/Last, BEVOR der Abruf einen evidence-Eintrag schreibt.
  const rl = await checkPortalReadLimit(contactId);
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'rate_limited', retryAfter: rl.retryAfter },
      { status: 429, headers: { 'retry-after': String(rl.retryAfter) } },
    );
  }

  const doc = await withTenantContext(
    { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' },
    async (tx) => {
      const d = await tx.document.findFirst({
        // Nur freigegebene Dokumente (Opt-in-Sharing).
        where: { id, clientId, deletedAt: null, sharedWithClientAt: { not: null } },
        include: { versions: { orderBy: { versionNo: 'desc' }, take: 1 } },
      });
      if (!d) return null;
      const version = d.versions[0];
      if (!version) return null;

      await evidenceService.record(tx, {
        tenantId,
        actorType: 'CLIENT_CONTACT',
        actorId: contactId,
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

  // App-proxied Download — Object-Store bleibt intern, direkt durchstreamen (O(1)).
  const obj = await streamObject(doc.bucket, doc.key);
  const contentType = effectiveDocumentMime({ ...doc, mimeType: obj.contentType ?? doc.mimeType });
  const headers: Record<string, string> = {
    'content-type': contentType,
    'content-disposition': `attachment; filename="${sanitizeFilenameForHeader(filenameWithExtension(doc.title, contentType))}"`,
    'cache-control': 'private, no-store',
  };
  if (obj.contentLength !== null) headers['content-length'] = String(obj.contentLength);
  return new NextResponse(obj.body, { status: 200, headers });
}
