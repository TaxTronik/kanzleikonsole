import { withTenantContext } from '@taxtronik/db';
import { NextResponse } from 'next/server';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { s3, MAX_UPLOAD_BYTES, sanitizeFilenameForHeader } from '@taxtronik/storage';
import { staffActionGuard } from '@/server/actions/staff-action';
import { portalActionGuard } from '@/server/actions/portal-action';
import { assertClientAccessTx } from '@/server/auth/rbac';
import { checkRateLimit } from '@/server/rate-limit';
import { evidenceService } from '@/server/container';
import { isUuid } from '@/lib/uuid';

async function loadSource(surface: 'staff' | 'portal', id: string) {
  const g =
    surface === 'staff'
      ? await staffActionGuard({ module: 'forms' })
      : await portalActionGuard({ module: 'forms' });
  if (!g.ok) throw new Error('Unavailable');
  return withTenantContext(g.ctx, async (tx) => {
    const file = await tx.formSubmissionRevisionFile.findUnique({
      where: { id },
      include: {
        revision: { include: { submission: { select: { clientId: true } } } },
        documentVersion: { include: { document: true } },
      },
    });
    if (!file) throw new Error('Unavailable');
    const clientId = file.revision.submission.clientId;
    if ('staffId' in g) await assertClientAccessTx(tx, g.session, clientId);
    else if (g.clientId !== clientId) throw new Error('Unavailable');
    const version = file.documentVersion,
      document = version.document;
    if (
      document.deletedAt ||
      document.clientId !== clientId ||
      (surface === 'portal' && !document.sharedWithClientAt) ||
      version.scanStatus !== 'CLEAN' ||
      !version.storageVersionId ||
      Buffer.from(version.sha256).toString('hex') !== file.sha256
    )
      throw new Error('Unavailable');
    const answers = file.revision.answers as Record<string, unknown>;
    const answer = answers[file.fieldKey];
    const fileName =
      answer &&
      typeof answer === 'object' &&
      !Array.isArray(answer) &&
      'fileName' in answer &&
      typeof answer.fileName === 'string'
        ? answer.fileName
        : 'Einreichung';
    return { file, version, document, fileName, g };
  });
}
// Fachkatalog: YEAR-END-CAMPAIGN-001, DOC-PORTAL-SHARING-001, DOC-VERSION-IMMUTABILITY-001.
export async function formRevisionDownload(surface: 'staff' | 'portal', id: string) {
  if (!isUuid(id)) return new NextResponse(null, { status: 404 });
  try {
    const source = await loadSource(surface, id);
    if (
      !(
        await checkRateLimit('form-revision-download:' + source.g.ctx.actorId, {
          max: 60,
          windowSec: 600,
        })
      ).ok
    )
      return new NextResponse(null, { status: 429 });
    const object = await s3.send(
      new GetObjectCommand({
        Bucket: source.version.storageBucket,
        Key: source.version.storageKey,
        VersionId: source.version.storageVersionId!,
      }),
    );
    if (!object.Body) throw new Error('Unavailable');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const part of object.Body as AsyncIterable<Uint8Array>) {
      const chunk = Buffer.from(part);
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) throw new Error('Unavailable');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (
      BigInt(size) !== source.version.sizeBytes ||
      createHash('sha256').update(bytes).digest('hex') !== source.file.sha256
    )
      throw new Error('Unavailable');
    await loadSource(surface, id);
    await withTenantContext(source.g.ctx, (tx) =>
      evidenceService.record(tx, {
        tenantId: source.g.tenantId,
        actorType: source.g.ctx.actorType,
        actorId: source.g.ctx.actorId,
        action: 'document.download',
        resourceType: 'document',
        resourceId: source.document.id,
        after: {
          formSubmissionRevisionId: source.file.revisionId,
          documentVersionId: source.version.id,
        },
      }),
    );
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        // Document metadata describes the latest version, not necessarily this
        // historical source. Never label old bytes with a later MIME/name.
        'content-type': 'application/octet-stream',
        'content-disposition':
          'attachment; filename="' + sanitizeFilenameForHeader(source.fileName) + '"',
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      },
    });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}
