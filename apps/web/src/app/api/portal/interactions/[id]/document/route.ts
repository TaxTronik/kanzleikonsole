import { NextResponse } from 'next/server';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { portalAuth } from '@/server/auth/portal';
import { withTenantContext } from '@taxtronik/db';
import { s3, sanitizeFilenameForHeader, MAX_UPLOAD_BYTES } from '@taxtronik/storage';
import { readModules } from '@/server/settings/modules';
import { noticeDecisionSnapshot } from '@/server/workflows/interactions';
import { evidenceService } from '@/server/container';
import { checkPortalReadLimit } from '@/server/rate-limit';
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
    const object = await s3.send(
      new GetObjectCommand({
        Bucket: source.version.storageBucket,
        Key: source.version.storageKey,
        VersionId: source.version.storageVersionId!,
      }),
    );
    if (!object.Body || (object.ContentLength ?? 0) > MAX_UPLOAD_BYTES)
      throw new Error('Invalid object size');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const part of object.Body as AsyncIterable<Uint8Array>) {
      const chunk = Buffer.from(part);
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) throw new Error('Object too large');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (createHash('sha256').update(bytes).digest('hex') !== source.snapshot.documentSha256)
      throw new Error('Snapshot hash mismatch');
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
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'content-type': source.document.mimeType,
        'content-disposition': `attachment; filename="${sanitizeFilenameForHeader(source.document.title)}"`,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch {
    return NextResponse.json({ error: 'document_unavailable' }, { status: 502 });
  }
}
