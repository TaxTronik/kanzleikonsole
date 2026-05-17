// =============================================================================
// GET /api/staff/documents/[id]/preview-url
//
// Liefert eine kurzlebige presigned-GET-URL (5 min) für die Inline-Anzeige
// im Browser. Im Gegensatz zu `/download` setzt diese URL kein
// Content-Disposition: attachment, sondern inline (so dass der Browser den
// PDF-Viewer benutzt).
// =============================================================================

import { NextResponse, type NextRequest } from 'next/server';
import { getClientIp } from '@/server/rate-limit';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { fetchObjectBytes } from '@taxtronik/storage';
import { evidenceService } from '@/server/container';
import { previewContentType, previewDisposition } from '@/server/storage/preview-mime';

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
      // Audit 4: expliziter Tenant-Filter zusätzlich zu RLS — Defense in Depth.
      const d = await tx.document.findFirst({
        where: { id, tenantId },
        include: { versions: { orderBy: { versionNo: 'desc' }, take: 1 } },
      });
      if (!d || !d.versions[0]) return null;
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'document.preview',
        resourceType: 'document',
        resourceId: id,
        ip: getClientIp(req.headers),
        userAgent: req.headers.get('user-agent'),
      });
      return {
        title: d.title,
        mimeType: d.mimeType,
        bucket: d.versions[0].storageBucket,
        key: d.versions[0].storageKey,
      };
    },
  );

  if (!doc) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // Zwei Modi (Object-Store bleibt intern, kein presigned-direct mehr):
  //  - ?stream=1 → Bytes inline durchstreamen (iframe/PDF-Viewer-src)
  //  - sonst     → JSON-Metadata; `url` zeigt auf diese Route mit ?stream=1
  // MIME-Whitelist verhindert, dass z. B. als text/html hochgeladene
  // Dateien inline gerendert werden (XSS).
  if (req.nextUrl.searchParams.get('stream') === '1') {
    const bytes = await fetchObjectBytes(doc.bucket, doc.key);
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'content-type': previewContentType(doc.mimeType),
        'content-disposition': previewDisposition(doc.mimeType, doc.title),
        'content-length': String(bytes.length),
        'cache-control': 'private, no-store',
      },
    });
  }

  const url = `${req.nextUrl.pathname}?stream=1`;
  return NextResponse.json({ url, mimeType: previewContentType(doc.mimeType), title: doc.title });
}
