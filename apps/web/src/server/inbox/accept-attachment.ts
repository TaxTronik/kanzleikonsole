import { createHash } from 'node:crypto';
import type { DocumentClassification } from '@prisma/client';
import type { ProtectionTier } from '@taxtronik/storage';
import { fetchObjectBytes } from '@taxtronik/storage';
import { withTenantContext, type TenantContext, type TxClient } from '@taxtronik/db';
import type { StaffSession } from '@/server/auth/staff';
import { ActionError } from '@/server/actions/action-error';
import { evidenceService } from '@/server/container';
import { carrierClassification } from '@/server/storage/document-type';
import { persistResumableDocumentUpload } from '@/server/documents/resumable-upload';
import { assertStaffInboxClientTx } from './access';

// Fachkatalog: DOC-RETENTION-CLASS-001, DOC-OBJECT-LOCK-001,
// DOC-VERSION-IMMUTABILITY-001, DOC-UPLOAD-JOURNAL-001,
// DOC-PORTAL-SHARING-001, PORTAL-INBOX-SUBMISSION-001 (Entwurf).

interface AcceptanceSource {
  attachmentId: string;
  clientId: string;
  messageId: string;
  mimeType: string;
  storageBucket: string;
  storageKey: string;
  storageVersionId: string | null;
  sha256: Uint8Array;
  sizeBytes: bigint;
  acceptedDocumentId: string | null;
  documentType: {
    id: string;
    tier: ProtectionTier;
    classificationKey: string | null;
    retentionYears: number | null;
  };
}

export interface AcceptedInboxAttachment {
  attachmentId: string;
  documentId: string;
  versionId: string | null;
  alreadyAccepted: boolean;
  staging: {
    storageBucket: string;
    storageKey: string;
    storageVersionId: string | null;
    sha256: Buffer;
    sizeBytes: bigint;
    mimeType: string;
  };
}

async function loadAcceptanceSource(
  context: TenantContext,
  session: StaffSession,
  input: { attachmentId: string; title: string; documentTypeId: string },
): Promise<AcceptanceSource | AcceptedInboxAttachment> {
  const { tenantId } = session.user;
  return withTenantContext(context, async (tx) => {
    const [locked] = await tx.$queryRaw<Array<{ id: string; clientId: string }>>`
      SELECT "id", "client_id" AS "clientId"
        FROM "portal_inbox_attachment"
       WHERE "id" = ${input.attachmentId}::uuid
         AND "tenant_id" = ${tenantId}::uuid
       FOR UPDATE
    `;
    if (!locked) throw new ActionError('Anlage nicht gefunden.');
    await assertStaffInboxClientTx(tx, session, locked.clientId, { requireUpload: true });

    const attachment = await tx.portalInboxAttachment.findFirst({
      where: {
        id: input.attachmentId,
        tenantId,
        clientId: locked.clientId,
        messageId: { not: null },
        scanStatus: 'CLEAN',
      },
      select: {
        id: true,
        clientId: true,
        messageId: true,
        mimeType: true,
        storageBucket: true,
        storageKey: true,
        storageVersionId: true,
        sha256: true,
        sizeBytes: true,
        decision: true,
        acceptedDocumentId: true,
        acceptedDocument: {
          select: {
            id: true,
            title: true,
            documentTypeId: true,
            versions: {
              orderBy: { versionNo: 'desc' },
              take: 1,
              select: { id: true },
            },
          },
        },
      },
    });
    if (!attachment?.messageId) throw new ActionError('Anlage nicht verfügbar.');
    if (attachment.decision === 'ACCEPTED') {
      if (
        !attachment.acceptedDocument ||
        attachment.acceptedDocument.title !== input.title ||
        attachment.acceptedDocument.documentTypeId !== input.documentTypeId
      ) {
        throw new ActionError('Die Anlage wurde bereits mit einer anderen Zuordnung übernommen.');
      }
      return {
        attachmentId: attachment.id,
        documentId: attachment.acceptedDocument.id,
        versionId: attachment.acceptedDocument.versions[0]?.id ?? null,
        alreadyAccepted: true,
        staging: {
          storageBucket: attachment.storageBucket,
          storageKey: attachment.storageKey,
          storageVersionId: attachment.storageVersionId,
          sha256: Buffer.from(attachment.sha256),
          sizeBytes: attachment.sizeBytes,
          mimeType: attachment.mimeType,
        },
      } satisfies AcceptedInboxAttachment;
    }
    if (attachment.decision !== 'PENDING_REVIEW') {
      throw new ActionError('Über diese Anlage wurde bereits entschieden.');
    }

    const type = await tx.documentType.findFirst({
      where: { id: input.documentTypeId, tenantId, active: true },
      select: {
        id: true,
        tier: true,
        classificationKey: true,
        retentionYears: true,
      },
    });
    if (!type) throw new ActionError('Aktiver Dokumenttyp nicht gefunden.');
    return {
      attachmentId: attachment.id,
      clientId: attachment.clientId,
      messageId: attachment.messageId,
      mimeType: attachment.mimeType,
      storageBucket: attachment.storageBucket,
      storageKey: attachment.storageKey,
      storageVersionId: attachment.storageVersionId,
      sha256: attachment.sha256,
      sizeBytes: attachment.sizeBytes,
      acceptedDocumentId: attachment.acceptedDocumentId,
      documentType: {
        ...type,
        tier: type.tier as ProtectionTier,
      },
    } satisfies AcceptanceSource;
  });
}

function isAcceptedResult(
  source: AcceptanceSource | AcceptedInboxAttachment,
): source is AcceptedInboxAttachment {
  return 'alreadyAccepted' in source;
}

export async function acceptInboxAttachment(input: {
  context: TenantContext;
  session: StaffSession;
  attachmentId: string;
  title: string;
  documentTypeId: string;
}): Promise<AcceptedInboxAttachment> {
  const { tenantId, staffId } = input.session.user;
  const source = await loadAcceptanceSource(input.context, input.session, input);
  if (isAcceptedResult(source)) return source;

  let activeDocumentId = source.acceptedDocumentId;
  const guardMutationTx = async (tx: TxClient): Promise<void> => {
    const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
        FROM "portal_inbox_attachment"
       WHERE "id" = ${source.attachmentId}::uuid
         AND "tenant_id" = ${tenantId}::uuid
         AND "client_id" = ${source.clientId}::uuid
       FOR UPDATE
    `;
    if (!locked) throw new ActionError('Die Übernahme wurde gleichzeitig geändert.');
    await assertStaffInboxClientTx(tx, input.session, source.clientId, { requireUpload: true });
    const type = await tx.documentType.findFirst({
      where: {
        id: source.documentType.id,
        tenantId,
        active: true,
        tier: source.documentType.tier,
        classificationKey: source.documentType.classificationKey,
        retentionYears: source.documentType.retentionYears,
      },
      select: { id: true },
    });
    if (!type) {
      throw new ActionError(
        'Dokumenttyp oder Aufbewahrungsklasse wurde geändert. Zuordnung erneut prüfen.',
      );
    }
    const attachment = await tx.portalInboxAttachment.findFirst({
      where: {
        id: source.attachmentId,
        tenantId,
        clientId: source.clientId,
        messageId: source.messageId,
        scanStatus: 'CLEAN',
        decision: 'PENDING_REVIEW',
        acceptedDocumentId: activeDocumentId,
      },
      select: { id: true },
    });
    if (!attachment) throw new ActionError('Die Übernahme wurde gleichzeitig geändert.');
  };

  const upload = await persistResumableDocumentUpload({
    context: input.context,
    resumeDocumentId: source.acceptedDocumentId,
    createdById: staffId,
    documentData: {
      tenantId,
      clientId: source.clientId,
      title: input.title,
      mimeType: source.mimeType,
      documentTypeId: source.documentType.id,
      classification: carrierClassification(
        source.documentType.tier,
        source.documentType.classificationKey,
      ) as DocumentClassification,
      // Erst recordCompleteTx gibt das fertig klassifizierte Dokument frei.
      sharedWithClientAt: null,
      sharedByStaff: null,
    },
    resumeWhere: {
      clientId: source.clientId,
      title: input.title,
      documentTypeId: source.documentType.id,
      deletedAt: null,
      sharedWithClientAt: null,
    },
    storage: {
      tier: source.documentType.tier,
      classification: source.documentType.classificationKey ?? undefined,
      expectedMime: source.mimeType,
      retentionYears: source.documentType.retentionYears ?? undefined,
    },
    readBytes: async () => {
      const bytes = await fetchObjectBytes(source.storageBucket, source.storageKey);
      const actual = createHash('sha256').update(bytes).digest();
      if (!actual.equals(Buffer.from(source.sha256)) || BigInt(bytes.length) !== source.sizeBytes) {
        throw new ActionError('Die Prüfsumme der Anlage stimmt nicht.');
      }
      return bytes;
    },
    guardMutationTx,
    assertDocumentAvailableTx: async (tx, documentId) => {
      const other = await tx.portalInboxAttachment.findFirst({
        where: { acceptedDocumentId: documentId, id: { not: source.attachmentId } },
        select: { id: true },
      });
      if (other) throw new ActionError('Dokument ist bereits einer anderen Anlage zugeordnet.');
    },
    recordPendingTx: async (tx, pending) => {
      const claimed = await tx.portalInboxAttachment.updateMany({
        where: {
          id: source.attachmentId,
          tenantId,
          clientId: source.clientId,
          messageId: source.messageId,
          scanStatus: 'CLEAN',
          decision: 'PENDING_REVIEW',
          acceptedDocumentId: null,
        },
        data: { acceptedDocumentId: pending.documentId },
      });
      if (claimed.count !== 1) throw new ActionError('Die Übernahme wurde bereits begonnen.');
      activeDocumentId = pending.documentId;
    },
    recordCompleteTx: async (tx, completed) => {
      await guardMutationTx(tx);
      const now = new Date();
      const accepted = await tx.portalInboxAttachment.updateMany({
        where: {
          id: source.attachmentId,
          acceptedDocumentId: completed.documentId,
          decision: 'PENDING_REVIEW',
          scanStatus: 'CLEAN',
        },
        data: {
          decision: 'ACCEPTED',
          rejectionReason: null,
          decidedByStaffId: staffId,
          decidedAt: now,
        },
      });
      if (accepted.count !== 1) throw new ActionError('Die Übernahme wurde gleichzeitig geändert.');
      await tx.document.update({
        where: { id: completed.documentId },
        data: { sharedWithClientAt: now, sharedByStaff: staffId },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'portal_inbox.attachment_accepted',
        resourceType: 'document',
        resourceId: completed.documentId,
        after: {
          sourceAttachmentId: source.attachmentId,
          sourceMessageId: source.messageId,
          versionId: completed.versionId,
          clientId: source.clientId,
          documentTypeId: source.documentType.id,
          sharedWithClient: true,
        },
      });
    },
    // PORTAL-INBOX-SUBMISSION-001 / DOC-UPLOAD-JOURNAL-001: Der Attachment-
    // Lock bleibt vom letzten Guard bis zur CLEAN-/ACCEPTED-Finalisierung
    // bestehen. Eine parallele Ablehnung gewinnt dadurch vollständig davor
    // oder sieht anschließend bereits den terminalen ACCEPTED-Zustand.
    commitWithinGuardTransaction: true,
  });

  return {
    attachmentId: source.attachmentId,
    documentId: upload.documentId,
    versionId: upload.versionId,
    alreadyAccepted: false,
    staging: {
      storageBucket: source.storageBucket,
      storageKey: source.storageKey,
      storageVersionId: source.storageVersionId,
      sha256: Buffer.from(source.sha256),
      sizeBytes: source.sizeBytes,
      mimeType: source.mimeType,
    },
  };
}
