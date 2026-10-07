import { NextResponse } from 'next/server';
import { portalAuth } from '@/server/auth/portal';
import { withTenantContext } from '@taxtronik/db';
import {
  bytesResponseBody,
  fetchVerifiedObjectBytes,
  sanitizeFilenameForHeader,
} from '@taxtronik/storage';
import { readModules } from '@/server/settings/modules';
import { noticeDecisionSnapshot } from '@/server/workflows/interactions';
import { evidenceService } from '@/server/container';
import { checkPortalReadLimit } from '@/server/rate-limit';
import { log } from '@/server/logger';
import { isUuid } from '@/lib/uuid';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await portalAuth();
  if (!session?.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const { tenantId, contactId, clientId } = session.user;
  const ctx = { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' as const };
  const modules = await readModules(ctx);
  if (!modules.noticeDecisions || !modules.taxNotices)
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!(await checkPortalReadLimit(contactId)).ok)
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  const source = await withTenantContext(ctx, async (tx) => {
    const row = await tx.clientInteraction.findFirst({
      where: { id, clientId, contactId, kind: 'NOTICE', status: { not: 'REVOKED' } },
    });
    if (!row) return null;
    const snapshot = noticeDecisionSnapshot.parse(row.snapshot);
    const document = await tx.document.findFirst({
      where: {
        id: snapshot.documentId,
        clientId,
        deletedAt: null,
        sharedWithClientAt: { not: null },
      },
      include: {
        versions: { where: { id: snapshot.documentVersionId, scanStatus: 'CLEAN' }, take: 1 },
      },
    });
    const version = document?.versions[0];
    if (
      !document ||
      !version ||
      !version.storageVersionId ||
      Buffer.from(version.sha256).toString('hex') !== snapshot.documentSha256
    )
      return null;
    return { document, version, snapshot };
  });
  if (!source) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  try {
    // R-05: gebundene Fassung über den gemeinsamen Leseweg — Größe und
    // SHA-256 des Entscheidungs-Snapshots werden vor Audit und Auslieferung geprüft.
    const bytes = await fetchVerifiedObjectBytes(
      {
        bucket: source.version.storageBucket,
        key: source.version.storageKey,
        versionId: source.version.storageVersionId!,
      },
      { sizeBytes: source.version.sizeBytes, sha256: source.snapshot.documentSha256 },
    );
    await withTenantContext(ctx, (tx) =>
      evidenceService.record(tx, {
        tenantId,
        actorType: 'CLIENT_CONTACT',
        actorId: contactId,
        action: 'notice.decision.document_download',
        resourceType: 'client_interaction',
        resourceId: id,
        after: { documentVersionId: source.version.id },
      }),
    );
    return new NextResponse(bytesResponseBody(bytes), {
      headers: {
        'content-type': source.document.mimeType,
        'content-disposition': `attachment; filename="${sanitizeFilenameForHeader(source.document.title)}"`,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (error) {
    // F-05: Speicher-, Prüfsummen- oder Audit-Fehler nicht still verschlucken.
    log.warn(
      {
        component: 'notice-decision-document',
        interactionId: id,
        documentVersionId: source.version.id,
        errName: error instanceof Error ? error.name : typeof error,
        err: error instanceof Error ? error.message : String(error),
      },
      'notice-decision-document: Download fehlgeschlagen',
    );
    return NextResponse.json({ error: 'document_unavailable' }, { status: 502 });
  }
}
