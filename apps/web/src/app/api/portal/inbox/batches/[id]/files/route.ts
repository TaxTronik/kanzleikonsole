import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { portalBaseUrl } from '@taxtronik/config';
import { portalAuth } from '@/server/auth/portal';
import { assertSameOrigin } from '@/server/http/assert-same-origin';
import { parseMultipartUpload } from '@/server/documents/upload-helpers';
import { checkPortalInboxUploadLimit, checkPortalWriteLimit } from '@/server/rate-limit';
import {
  InboxUploadError,
  InboxUploadPolicyError,
  stageInboxAttachment,
} from '@/server/inbox/staging-upload';
import { log } from '@/server/logger';

// Fachkatalog: ACCESS-TENANT-RLS-001, CLIENT-MANDATE-LIFECYCLE-001,
// DOC-UPLOAD-JOURNAL-001, PORTAL-INBOX-SUBMISSION-001 (Entwurf).

const ParamsSchema = z.object({ id: z.uuid() });
const ResumeSchema = z.uuid().optional();

function publicUploadError(error: unknown): NextResponse {
  const wrapped = error instanceof InboxUploadError ? error : null;
  const cause = wrapped?.cause ?? error;
  const retry = wrapped?.attachmentId
    ? { retryable: true, attachmentId: wrapped.attachmentId }
    : {};

  if (cause instanceof InboxUploadPolicyError) {
    if (cause.code === 'LIMIT') {
      return NextResponse.json({ error: 'upload_limit', ...retry }, { status: 413 });
    }
    if (cause.code === 'BATCH_UNAVAILABLE') {
      return NextResponse.json({ error: 'batch_unavailable', ...retry }, { status: 409 });
    }
    // Malware-, Verschluesselungs- und Formatdetails bleiben intern neutral.
    return NextResponse.json({ error: 'file_blocked' }, { status: 422 });
  }

  const message = cause instanceof Error ? cause.message : '';
  if (message.startsWith('TOO_LARGE')) {
    return NextResponse.json({ error: 'upload_limit', ...retry }, { status: 413 });
  }
  if (message.startsWith('INFECTED')) {
    return NextResponse.json({ error: 'file_blocked' }, { status: 422 });
  }
  if (message.startsWith('SCAN_ERROR')) {
    return NextResponse.json({ error: 'scan_unavailable', ...retry }, { status: 503 });
  }

  log.error(
    {
      component: 'portal-inbox-upload',
      phase: wrapped?.phase ?? 'unknown',
      attachmentId: wrapped?.attachmentId ?? null,
      // Kein Original-Dateiname und keine Diagnose im strukturierten Log.
      errorType: cause instanceof Error ? cause.name : typeof cause,
    },
    'portal inbox upload failed',
  );
  return NextResponse.json({ error: 'upload_failed', ...retry }, { status: 503 });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const originError = assertSameOrigin(request, portalBaseUrl);
  if (originError) return originError;

  const session = await portalAuth();
  if (!session?.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const parsedParams = ParamsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json({ error: 'batch_unavailable' }, { status: 404 });
  }

  const [writeLimit, uploadLimit] = await Promise.all([
    checkPortalWriteLimit(session.user.contactId),
    checkPortalInboxUploadLimit(session.user.contactId),
  ]);
  if (!writeLimit.ok || !uploadLimit.ok) {
    return NextResponse.json(
      {
        error: 'rate_limited',
        retryAfter: Math.max(
          writeLimit.ok ? 0 : writeLimit.retryAfter,
          uploadLimit.ok ? 0 : uploadLimit.retryAfter,
        ),
      },
      { status: 429 },
    );
  }

  const upload = await parseMultipartUpload(request);
  if (!upload.ok) return upload.response;

  const resume = ResumeSchema.safeParse(upload.form.get('resumeAttachmentId') || undefined);
  if (!resume.success) {
    return NextResponse.json({ error: 'validation' }, { status: 400 });
  }
  const fileName =
    'name' in upload.file && typeof upload.file.name === 'string' ? upload.file.name : 'anlage';

  try {
    const attachment = await stageInboxAttachment({
      actor: {
        context: {
          tenantId: session.user.tenantId,
          actorId: session.user.contactId,
          actorType: 'CLIENT_CONTACT',
        },
        tenantId: session.user.tenantId,
        clientId: session.user.clientId,
        contactId: session.user.contactId,
      },
      batchId: parsedParams.data.id,
      fileData: Buffer.from(await upload.file.arrayBuffer()),
      originalName: fileName,
      resumeAttachmentId: resume.data,
    });
    return NextResponse.json({ ok: true, attachment });
  } catch (error) {
    return publicUploadError(error);
  }
}
