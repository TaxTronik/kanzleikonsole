import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { env } from '@taxtronik/config';
import { withTenantContext } from '@taxtronik/db';
import { commitBytesWithTier } from '@taxtronik/storage';
import { staffActionGuard } from '@/server/actions/staff-action';
import { evidenceService } from '@/server/container';
import { assertSameOrigin } from '@/server/http/assert-same-origin';
import {
  createDocumentWithVersion,
  parseMultipartUpload,
  storageCommitErrorResponse,
} from '@/server/documents/upload-helpers';
import { compensateStorageCommit } from '@/server/documents/storage-compensation';

const FieldsSchema = z.object({
  draftToken: z.string().uuid(),
  articleId: z.string().uuid().optional(),
  displayName: z.string().trim().min(1).max(500),
  mimeType: z.string().trim().min(1).max(255).default('application/octet-stream'),
});

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
  const references = await withTenantContext(ctx, async (tx) => {
    if (parsed.data.articleId) {
      const article = await tx.kbArticle.findFirst({
        where: { id: parsed.data.articleId, tenantId },
        select: { id: true },
      });
      if (!article) return null;
    }
    const generalType = await tx.documentType.findFirst({
      where: { tenantId, classificationKey: 'GENERAL', builtin: true, active: true },
      select: { id: true },
    });
    return { documentTypeId: generalType?.id ?? null };
  });
  if (!references) {
    return NextResponse.json({ error: 'article_not_found' }, { status: 404 });
  }

  let commit;
  try {
    commit = await commitBytesWithTier({
      fileData: Buffer.from(await file.arrayBuffer()),
      tier: 'NONE',
      tenantId,
      classification: 'GENERAL',
    });
  } catch (error) {
    return storageCommitErrorResponse(error);
  }

  try {
    const attachment = await withTenantContext(ctx, async (tx) => {
      if (parsed.data.articleId) {
        const article = await tx.kbArticle.findFirst({
          where: { id: parsed.data.articleId, tenantId },
          select: { id: true },
        });
        if (!article) throw new Error('KB_ARTICLE_REFERENCE_CHANGED');
      }

      const effectiveMime = commit.detectedMime ?? parsed.data.mimeType;
      const { document } = await createDocumentWithVersion(tx, {
        documentData: {
          tenantId,
          clientId: null,
          ownerStaffId: staffId,
          title: parsed.data.displayName,
          classification: 'GENERAL',
          documentTypeId: references.documentTypeId,
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
    });

    return NextResponse.json({
      ok: true,
      attachment: {
        id: attachment.id,
        displayName: attachment.displayName,
        mimeType: attachment.mimeType,
      },
    });
  } catch (error) {
    await compensateStorageCommit({
      tenantId,
      source: 'knowledge.attachment.upload',
      commit,
      cause: error,
    });
    return NextResponse.json({ error: 'upload_commit_failed' }, { status: 409 });
  }
}
