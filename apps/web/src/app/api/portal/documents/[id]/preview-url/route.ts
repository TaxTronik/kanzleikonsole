import { NextResponse, type NextRequest } from 'next/server';
import { getClientIp, checkPortalReadLimit } from '@/server/rate-limit';
import { portalAuth } from '@/server/auth/portal';
import { withTenantContext } from '@taxtronik/db';
import { streamObject } from '@taxtronik/storage';
import { evidenceService } from '@/server/container';
import {
  previewContentType,
  previewDisposition,
  previewSecurityHeaders,
} from '@/server/storage/preview-mime';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await portalAuth();
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const { tenantId, contactId, clientId } = session.user;

  // Audit 2026-06 Befund 6: Read-Limit pro Session-Kontakt (gemeinsamer
  // Bucket mit der Download-Route) — deckelt Audit-Spam/Last, BEVOR der
  // Abruf einen evidence-Eintrag schreibt.
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
        // Nur freigegebene Dokumente — sonst könnte ein Mandant per
        // erratener ID ein nicht-geteiltes Dokument abrufen.
        where: { id, clientId, deletedAt: null, sharedWithClientAt: { not: null } },
        include: { versions: { orderBy: { versionNo: 'desc' }, take: 1 } },
      });
      if (!d || !d.versions[0]) return null;
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'CLIENT_CONTACT',
        actorId: contactId,
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

  // Object-Store bleibt intern: ?stream=1 streamt Bytes inline, sonst
  // JSON-Metadata mit `url` auf diese Route mit ?stream=1.
  if (req.nextUrl.searchParams.get('stream') === '1') {
    const obj = await streamObject(doc.bucket, doc.key);
    const headers: Record<string, string> = {
      'content-type': previewContentType(doc.mimeType, doc.title),
      'content-disposition': previewDisposition(doc.mimeType, doc.title),
      'cache-control': 'private, no-store',
      // Audit 2026-06 Befund 4: CSP sandbox für text/plain — Inline-Anzeige
      // hängt nicht mehr allein an nosniff.
      ...previewSecurityHeaders(doc.mimeType, doc.title),
    };
    if (obj.contentLength !== null) headers['content-length'] = String(obj.contentLength);
    return new NextResponse(obj.body, { status: 200, headers });
  }

  const url = `${req.nextUrl.pathname}?stream=1`;
  return NextResponse.json({ url, mimeType: previewContentType(doc.mimeType, doc.title), title: doc.title });
}
