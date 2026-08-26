import { NextResponse, type NextRequest } from 'next/server';

import { portalAuth } from '@/server/auth/portal';
import { documentDownloadResponse, loadDocumentDelivery } from '@/server/documents/delivery';
import { checkPortalReadLimit } from '@/server/rate-limit';
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

  // Fachkatalog DOC-PORTAL-SHARING-001: Limit greift vor DB und Audit.
  const limit = await checkPortalReadLimit(contactId);
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'rate_limited', retryAfter: limit.retryAfter },
      { status: 429, headers: { 'retry-after': String(limit.retryAfter) } },
    );
  }

  const document = await loadDocumentDelivery({
    tenantId,
    actorId: contactId,
    actorType: 'CLIENT_CONTACT',
    documentId: id,
    action: 'document.download',
    request: req,
    // Kein Existenz-Leak: fremd, geloescht oder nicht freigegeben => 404.
    where: { id, clientId, deletedAt: null, sharedWithClientAt: { not: null } },
  });
  if (!document) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // Bestehende Portal-Policy: vorhandenen Storage-Typ beruecksichtigen.
  return documentDownloadResponse(document, { mimeSource: 'storage-when-present' });
}
