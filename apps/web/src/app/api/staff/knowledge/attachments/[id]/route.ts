import { NextResponse, type NextRequest } from 'next/server';
import { withTenantContext } from '@taxtronik/db';
import { sanitizeFilenameForHeader, streamObject } from '@taxtronik/storage';
import { staffActionGuard } from '@/server/actions/staff-action';
import { evidenceService } from '@/server/container';
import { isUuid } from '@/lib/uuid';
import {
  effectiveDocumentMime,
  filenameWithExtension,
  previewDisposition,
  previewSecurityHeaders,
} from '@/server/storage/preview-mime';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await staffActionGuard({ module: 'knowledge' });
  if (!guard.ok) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const attachment = await withTenantContext(guard.ctx, async (tx) => {
    const entry = await tx.kbAttachment.findFirst({
      where: { id, tenantId: guard.tenantId },
      include: {
        document: {
          select: {
            title: true,
            mimeType: true,
            classification: true,
            deletedAt: true,
            versions: {
              orderBy: { versionNo: 'desc' },
              take: 1,
              select: { storageBucket: true, storageKey: true, scanStatus: true },
            },
          },
        },
      },
    });
    if (
      !entry ||
      entry.document.deletedAt !== null ||
      entry.document.versions[0]?.scanStatus !== 'CLEAN' ||
      (entry.articleId === null && entry.uploadedBy !== guard.staffId)
    ) {
      return null;
    }
    await evidenceService.record(tx, {
      tenantId: guard.tenantId,
      actorType: 'STAFF',
      actorId: guard.staffId,
      action:
        req.nextUrl.searchParams.get('download') === '1'
          ? 'kb.attachment.download'
          : 'kb.attachment.view',
      resourceType: 'kb_attachment',
      resourceId: entry.id,
    });
    return entry;
  });
  const version = attachment?.document.versions[0];
  if (!attachment || !version) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const object = await streamObject(version.storageBucket, version.storageKey);
  const mimeType = effectiveDocumentMime(attachment.document);
  const filename = filenameWithExtension(attachment.displayName, mimeType);
  const download = req.nextUrl.searchParams.get('download') === '1';
  const headers: Record<string, string> = {
    'content-type': mimeType,
    'content-disposition': download
      ? `attachment; filename="${sanitizeFilenameForHeader(filename)}"`
      : previewDisposition(mimeType, filename),
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    ...previewSecurityHeaders(mimeType, filename),
  };
  if (object.contentLength !== null) headers['content-length'] = String(object.contentLength);
  return new NextResponse(object.body, { status: 200, headers });
}
