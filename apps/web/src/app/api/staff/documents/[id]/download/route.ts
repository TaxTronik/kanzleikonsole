import { NextResponse, type NextRequest } from 'next/server';

import { canAccessClientTx } from '@/server/auth/rbac';
import { staffAuth } from '@/server/auth/staff';
import { documentDownloadResponse, loadDocumentDelivery } from '@/server/documents/delivery';
import { isUuid } from '@/lib/uuid';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await staffAuth();
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const { tenantId, staffId } = session.user;

  const document = await loadDocumentDelivery({
    tenantId,
    actorId: staffId,
    actorType: 'STAFF',
    documentId: id,
    action: 'document.download',
    request: req,
    // Expliziter Tenant-/Soft-Delete-Filter zusaetzlich zu RLS.
    where: { id, tenantId, deletedAt: null },
    authorize: (tx, candidate) =>
      candidate.clientId
        ? canAccessClientTx(tx, session, candidate.clientId)
        : Promise.resolve(true),
  });
  if (!document) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // Der beim Upload validierte DB-Typ bleibt fuer Staff-Downloads massgeblich.
  return documentDownloadResponse(document, { mimeSource: 'validated-document' });
}
