import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { env } from '@taxtronik/config';
import type { TxClient } from '@taxtronik/db';
import { staffActionGuard } from '@/server/actions/staff-action';
import { evidenceService } from '@/server/container';
import { assertSameOrigin } from '@/server/http/assert-same-origin';
import {
  createDocumentWithVersion,
  parseMultipartUpload,
  storageCommitErrorResponse,
} from '@/server/documents/upload-helpers';
import { JournaledUploadError, runJournaledUpload } from '@/server/documents/journaled-upload';
import { log } from '@/server/logger';

const FieldsSchema = z.object({
  draftToken: z.string().uuid(),
  articleId: z.string().uuid().optional(),
  displayName: z.string().trim().min(1).max(500),
  mimeType: z.string().trim().min(1).max(255).default('application/octet-stream'),
});

class KbArticleMissingError extends Error {}

/**
 * Gemeinsame Vor- und Nachprüfung (K-06 / DOC-UPLOAD-JOURNAL-001): Der Artikel
 * muss vor Scan, Journal und Object-Write und erneut in der Commit-Transaktion
 * zum Tenant gehören.
 */
async function checkAttachmentTx(
  tx: TxClient,
  tenantId: string,
  articleId: string | undefined,
): Promise<{ documentTypeId: string | null }> {
  if (articleId) {
    const article = await tx.kbArticle.findFirst({
      where: { id: articleId, tenantId },
      select: { id: true },
    });
    if (!article) throw new KbArticleMissingError();
  }
  const generalType = await tx.documentType.findFirst({
    where: { tenantId, classificationKey: 'GENERAL', builtin: true, active: true },
    select: { id: true },
  });
  return { documentTypeId: generalType?.id ?? null };
}

export async function POST(req: NextRequest) {
  const csrf = assertSameOrigin(req, env.NEXTAUTH_URL);
  if (csrf) return csrf;

  const guard = await staffActionGuard({ module: 'knowledge' });
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: 403 });
  }

  const upload = await parseMultipartUpload(req);
  if (!upload.ok) return upload.response;
  const { form, file } = upload;
  const parsed = FieldsSchema.safeParse({
    draftToken: form.get('draftToken'),
    articleId: form.get('articleId') || undefined,
    displayName: form.get('displayName'),
    mimeType: form.get('mimeType') || undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'validation', issues: parsed.error.issues }, { status: 400 });
  }

  const { tenantId, staffId, ctx } = guard;
  let stored;
  try {
    stored = await runJournaledUpload({
      context: ctx,
      source: 'knowledge.attachment.upload',
      check: (tx) => checkAttachmentTx(tx, tenantId, parsed.data.articleId),
      readBytes: async () => Buffer.from(await file.arrayBuffer()),
      storage: () => ({ tier: 'NONE', classification: 'GENERAL' }),
      commitTx: async (tx, { commit, checked }) => {
        const effectiveMime = commit.detectedMime ?? parsed.data.mimeType;
        const { document } = await createDocumentWithVersion(tx, {
          documentData: {
            tenantId,
            clientId: null,
            ownerStaffId: staffId,
            title: parsed.data.displayName,
            classification: 'GENERAL',
            documentTypeId: checked.documentTypeId,
            mimeType: effectiveMime,
          },
          commit,
          createdById: staffId,
        });
        const created = await tx.kbAttachment.create({
          data: {
            tenantId,
            articleId: parsed.data.articleId ?? null,
            documentId: document.id,
            draftToken: parsed.data.draftToken,
            displayName: parsed.data.displayName,
            mimeType: effectiveMime,
            uploadedBy: staffId,
          },
        });
        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'kb.attachment.upload',
          resourceType: 'kb_attachment',
          resourceId: created.id,
          after: {
            articleId: parsed.data.articleId ?? null,
            documentId: document.id,
            displayName: created.displayName,
            mimeType: created.mimeType,
            sha256: commit.sha256.toString('hex'),
          },
        });
        return created;
      },
    });
  } catch (error) {
    return uploadErrorResponse(error, tenantId);
  }

  const attachment = stored.result;
  return NextResponse.json({
    ok: true,
    attachment: {
      id: attachment.id,
      displayName: attachment.displayName,
      mimeType: attachment.mimeType,
    },
  });
}

function uploadErrorResponse(error: unknown, tenantId: string): NextResponse {
  const phase = error instanceof JournaledUploadError ? error.phase : null;
  const cause = error instanceof JournaledUploadError ? error.cause : error;
  if (phase === 'check' && cause instanceof KbArticleMissingError) {
    return NextResponse.json({ error: 'article_not_found' }, { status: 404 });
  }
  if (phase === 'prepare' || phase === 'store') return storageCommitErrorResponse(cause);
  if (phase === 'commit') {
    // Die Speicherabsicht bleibt offen; der Cleanup-Worker räumt das Objekt
    // nach der Sicherheitsfrist versionsgenau auf.
    return NextResponse.json({ error: 'upload_commit_failed' }, { status: 409 });
  }
  log.error(
    { component: 'knowledge-attachment', tenantId, phase, err: (cause as Error)?.message ?? null },
    'knowledge-attachment: Upload vor dem Object-Write abgebrochen',
  );
  return NextResponse.json({ error: 'internal_error' }, { status: 500 });
}
