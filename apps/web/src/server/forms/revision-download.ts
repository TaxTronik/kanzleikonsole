import { withTenantContext } from '@taxtronik/db';
import { NextResponse } from 'next/server';
import {
  bytesResponseBody,
  fetchVerifiedObjectBytes,
  sanitizeFilenameForHeader,
} from '@taxtronik/storage';
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
    // R-05: Größe und SHA-256 der gebundenen Fassung werden vor Audit und
    // Auslieferung geprüft (gemeinsamer Leseweg mit Größenlimit).
    const bytes = await fetchVerifiedObjectBytes(
      {
        bucket: source.version.storageBucket,
        key: source.version.storageKey,
        versionId: source.version.storageVersionId!,
      },
      { sizeBytes: source.version.sizeBytes, sha256: source.file.sha256 },
    );
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
    return new NextResponse(bytesResponseBody(bytes), {
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
