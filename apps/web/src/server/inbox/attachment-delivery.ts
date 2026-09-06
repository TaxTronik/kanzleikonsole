import { NextResponse, type NextRequest } from 'next/server';
import { withTenantContext, type TenantContext } from '@taxtronik/db';
import { sanitizeFilenameForHeader, streamObject } from '@taxtronik/storage';
import type { PortalSession } from '@/server/auth/portal';
import type { StaffSession } from '@/server/auth/staff';
import { evidenceService } from '@/server/container';
import { getClientIp } from '@/server/rate-limit';
import { assertActivePortalInboxIdentityTx, assertStaffInboxClientTx } from './access';

// Fachkatalog: ACCESS-TENANT-RLS-001, DOC-PORTAL-SHARING-001,
// AUDIT-HASH-CHAIN-001, PORTAL-INBOX-SUBMISSION-001 (Entwurf).

export interface InboxAttachmentObject {
  bucket: string;
  key: string;
  mimeType: string;
  downloadName: string;
  audit: {
    context: TenantContext;
    actorType: 'CLIENT_CONTACT' | 'STAFF';
    actorId: string;
    attachmentId: string;
    acceptedDocument: boolean;
  };
}

async function loadPortalAttachment(
  session: PortalSession,
  attachmentId: string,
): Promise<InboxAttachmentObject | null> {
  const { tenantId, clientId, contactId } = session.user;
  return withTenantContext(
    { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' },
    async (tx) => {
      await assertActivePortalInboxIdentityTx(tx, { tenantId, clientId, contactId });
      const attachment = await tx.portalInboxAttachment.findFirst({
        where: {
          id: attachmentId,
          tenantId,
          clientId,
          messageId: { not: null },
          scanStatus: 'CLEAN',
          decision: { in: ['PENDING_REVIEW', 'ACCEPTED'] },
          batch: { status: 'CONSUMED' },
        },
        select: {
          id: true,
          originalName: true,
          mimeType: true,
          storageBucket: true,
          storageKey: true,
          decision: true,
          acceptedDocument: {
            select: {
              title: true,
              mimeType: true,
              deletedAt: true,
              sharedWithClientAt: true,
              versions: {
                orderBy: { versionNo: 'desc' },
                take: 1,
                select: { storageBucket: true, storageKey: true },
              },
            },
          },
        },
      });
      if (!attachment) return null;
      const accepted = attachment.acceptedDocument;
      const acceptedVersion = accepted?.versions[0];
      const useAccepted =
        attachment.decision === 'ACCEPTED' &&
        accepted?.deletedAt === null &&
        accepted.sharedWithClientAt !== null &&
        Boolean(acceptedVersion);
      if (attachment.decision === 'ACCEPTED' && !useAccepted) return null;

      const object = useAccepted
        ? {
            bucket: acceptedVersion!.storageBucket,
            key: acceptedVersion!.storageKey,
            mimeType: accepted!.mimeType,
            downloadName: accepted!.title,
          }
        : {
            bucket: attachment.storageBucket,
            key: attachment.storageKey,
            mimeType: attachment.mimeType,
            downloadName: attachment.originalName,
          };
      return {
        ...object,
        audit: {
          context: { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' },
          actorType: 'CLIENT_CONTACT' as const,
          actorId: contactId,
          attachmentId: attachment.id,
          acceptedDocument: useAccepted,
        },
      };
    },
  );
}

async function loadStaffAttachment(
  session: StaffSession,
  attachmentId: string,
): Promise<InboxAttachmentObject | null> {
  const { tenantId, staffId } = session.user;
  return withTenantContext({ tenantId, actorId: staffId, actorType: 'STAFF' }, async (tx) => {
    const attachment = await tx.portalInboxAttachment.findFirst({
      where: {
        id: attachmentId,
        tenantId,
        messageId: { not: null },
        scanStatus: 'CLEAN',
        decision: { in: ['PENDING_REVIEW', 'ACCEPTED'] },
      },
      select: {
        id: true,
        clientId: true,
        originalName: true,
        mimeType: true,
        storageBucket: true,
        storageKey: true,
        decision: true,
        acceptedDocument: {
          select: {
            title: true,
            mimeType: true,
            deletedAt: true,
            versions: {
              orderBy: { versionNo: 'desc' },
              take: 1,
              select: { storageBucket: true, storageKey: true },
            },
          },
        },
      },
    });
    if (!attachment) return null;
    await assertStaffInboxClientTx(tx, session, attachment.clientId);
    const accepted = attachment.acceptedDocument;
    const acceptedVersion = accepted?.versions[0];
    const useAccepted =
      attachment.decision === 'ACCEPTED' &&
      accepted?.deletedAt === null &&
      Boolean(acceptedVersion);
    if (attachment.decision === 'ACCEPTED' && !useAccepted) return null;

    const object = useAccepted
      ? {
          bucket: acceptedVersion!.storageBucket,
          key: acceptedVersion!.storageKey,
          mimeType: accepted!.mimeType,
          downloadName: accepted!.title,
        }
      : {
          bucket: attachment.storageBucket,
          key: attachment.storageKey,
          mimeType: attachment.mimeType,
          downloadName: attachment.originalName,
        };
    return {
      ...object,
      audit: {
        context: { tenantId, actorId: staffId, actorType: 'STAFF' },
        actorType: 'STAFF' as const,
        actorId: staffId,
        attachmentId: attachment.id,
        acceptedDocument: useAccepted,
      },
    };
  });
}

export async function portalInboxAttachmentDownloadResponse(
  request: NextRequest,
  session: PortalSession,
  attachmentId: string,
): Promise<NextResponse> {
  const source = await loadPortalAttachment(session, attachmentId);
  return source
    ? buildInboxAttachmentDownloadResponse(request, source)
    : NextResponse.json({ error: 'not_found' }, { status: 404 });
}

export async function staffInboxAttachmentDownloadResponse(
  request: NextRequest,
  session: StaffSession,
  attachmentId: string,
): Promise<NextResponse> {
  const source = await loadStaffAttachment(session, attachmentId);
  return source
    ? buildInboxAttachmentDownloadResponse(request, source)
    : NextResponse.json({ error: 'not_found' }, { status: 404 });
}

export async function buildInboxAttachmentDownloadResponse(
  request: NextRequest,
  source: InboxAttachmentObject,
): Promise<NextResponse> {
  const object = await streamObject(source.bucket, source.key);
  // Erst ein erfolgreich geöffnetes Storage-Objekt wird protokolliert. Das
  // Ereignis behauptet bewusst keinen vollständig übertragenen Response-Body.
  await withTenantContext(source.audit.context, (tx) =>
    evidenceService.record(tx, {
      tenantId: source.audit.context.tenantId,
      actorType: source.audit.actorType,
      actorId: source.audit.actorId,
      action: 'portal_inbox.attachment_download_stream_opened',
      resourceType: 'portal_inbox_attachment',
      resourceId: source.audit.attachmentId,
      after: { acceptedDocument: source.audit.acceptedDocument },
      ip: getClientIp(request.headers),
      userAgent: request.headers.get('user-agent'),
    }),
  );
  const headers: Record<string, string> = {
    'content-type': source.mimeType || 'application/octet-stream',
    'content-disposition': `attachment; filename="${sanitizeFilenameForHeader(source.downloadName)}"`,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  };
  if (object.contentLength !== null) headers['content-length'] = String(object.contentLength);
  return new NextResponse(object.body, { status: 200, headers });
}
