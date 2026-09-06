import type { PreparedBytesCommit } from '@taxtronik/storage';
import {
  commitPreparedBytes,
  prepareBytesCommitWithTier,
  recoverPreparedBytesCommit,
} from '@taxtronik/storage';
import { withTenantContext, type TenantContext } from '@taxtronik/db';
import { prismaBytes } from '@/server/db/prisma-bytes';
import { compensateStorageCommit } from '@/server/documents/storage-compensation';
import {
  INBOX_MAX_ATTACHMENTS,
  INBOX_MAX_FILE_BYTES,
  INBOX_MAX_TOTAL_BYTES,
  isAllowedInboxMime,
  sanitizeInboxOriginalName,
} from './constants';
import { assertActivePortalInboxIdentityTx } from './access';

// Fachkatalog: DOC-UPLOAD-JOURNAL-001, FORM-PRESUBMIT-UPLOAD-001,
// DOC-PORTAL-SHARING-001, PORTAL-INBOX-SUBMISSION-001 (Entwurf).

export type InboxUploadPhase = 'prepare' | 'journal' | 'commit' | 'finalize' | 'resume';

export class InboxUploadError extends Error {
  override readonly cause: unknown;

  constructor(
    readonly phase: InboxUploadPhase,
    cause: unknown,
    readonly attachmentId?: string,
  ) {
    super(cause instanceof Error ? cause.message : `INBOX_UPLOAD_${phase.toUpperCase()}_FAILED`);
    this.name = 'InboxUploadError';
    this.cause = cause;
  }
}

export class InboxUploadPolicyError extends Error {
  constructor(readonly code: 'TYPE_BLOCKED' | 'ENCRYPTED_PDF' | 'LIMIT' | 'BATCH_UNAVAILABLE') {
    super(code);
    this.name = 'InboxUploadPolicyError';
  }
}

export interface InboxUploadContext {
  context: TenantContext;
  tenantId: string;
  clientId: string;
  contactId: string;
}

export interface InboxStagedAttachment {
  attachmentId: string;
  originalName: string;
  mimeType: string;
  sizeBytes: string;
  resumed: boolean;
}

function normalizedDetectedMime(value: string | null): string | null {
  if (!value) return null;
  return value.toLowerCase() === 'text/xml' ? 'application/xml' : value.toLowerCase();
}

function containsPdfEncryptionDictionary(bytes: Buffer): boolean {
  // Verschluesselte PDFs tragen im Trailer-Dictionary einen /Encrypt-Eintrag.
  // Konservativ blockieren: Der sichere Eingang fuehrt in 0.3.0 keine
  // Passwortdialoge oder Entschluesselung aus.
  if (bytes.length < 5 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') return false;
  return bytes.includes(Buffer.from('/Encrypt', 'ascii'));
}

async function inspectInboxBytes(fileData: Buffer, tenantId: string): Promise<PreparedBytesCommit> {
  if (fileData.length > INBOX_MAX_FILE_BYTES) {
    throw new InboxUploadPolicyError('LIMIT');
  }
  const prepared = await prepareBytesCommitWithTier({ fileData, tier: 'NONE', tenantId });
  const mime = normalizedDetectedMime(prepared.detectedMime);
  if (!isAllowedInboxMime(mime)) throw new InboxUploadPolicyError('TYPE_BLOCKED');
  if (mime === 'application/pdf' && containsPdfEncryptionDictionary(fileData)) {
    throw new InboxUploadPolicyError('ENCRYPTED_PDF');
  }
  return { ...prepared, detectedMime: mime };
}

function preparedFromIntent(intent: {
  tenantId: string;
  storageBucket: string;
  storageKey: string;
  sha256: Uint8Array;
  sizeBytes: bigint;
  mimeType: string;
}): PreparedBytesCommit {
  return {
    tier: 'NONE',
    tenantId: intent.tenantId,
    targetBucket: intent.storageBucket,
    targetKey: intent.storageKey,
    sha256: Buffer.from(intent.sha256),
    sizeBytes: intent.sizeBytes,
    immutable: false,
    retentionUntil: null,
    detectedMime: intent.mimeType,
  };
}

async function journalNewIntent(
  actor: InboxUploadContext,
  batchId: string,
  originalName: string,
  prepared: PreparedBytesCommit,
): Promise<string> {
  return withTenantContext(actor.context, async (tx) => {
    await assertActivePortalInboxIdentityTx(tx, { ...actor, requireUpload: true });
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
        FROM "portal_inbox_upload_batch"
       WHERE "id" = ${batchId}::uuid
         AND "tenant_id" = ${actor.tenantId}::uuid
         AND "client_id" = ${actor.clientId}::uuid
         AND "created_by_contact_id" = ${actor.contactId}::uuid
       FOR UPDATE
    `;
    if (!locked[0]) throw new InboxUploadPolicyError('BATCH_UNAVAILABLE');

    const batch = await tx.portalInboxUploadBatch.findFirst({
      where: {
        id: batchId,
        tenantId: actor.tenantId,
        clientId: actor.clientId,
        createdByContactId: actor.contactId,
        status: 'OPEN',
        expiresAt: { gt: new Date() },
      },
      select: {
        id: true,
        attachments: { select: { sizeBytes: true, position: true } },
      },
    });
    if (!batch) throw new InboxUploadPolicyError('BATCH_UNAVAILABLE');
    if (batch.attachments.length >= INBOX_MAX_ATTACHMENTS) {
      throw new InboxUploadPolicyError('LIMIT');
    }
    const total = batch.attachments.reduce((sum, item) => sum + item.sizeBytes, 0n);
    if (total + prepared.sizeBytes > BigInt(INBOX_MAX_TOTAL_BYTES)) {
      throw new InboxUploadPolicyError('LIMIT');
    }
    const position = batch.attachments.reduce((max, item) => Math.max(max, item.position), -1) + 1;
    const attachment = await tx.portalInboxAttachment.create({
      data: {
        tenantId: actor.tenantId,
        clientId: actor.clientId,
        batchId,
        originalName,
        mimeType: prepared.detectedMime!,
        storageBucket: prepared.targetBucket,
        storageKey: prepared.targetKey,
        storageVersionId: null,
        sha256: prismaBytes(prepared.sha256),
        sizeBytes: prepared.sizeBytes,
        scanStatus: 'PENDING',
        decision: 'PENDING_REVIEW',
        position,
      },
      select: { id: true },
    });
    return attachment.id;
  });
}

async function loadResumeIntent(actor: InboxUploadContext, batchId: string, attachmentId: string) {
  return withTenantContext(actor.context, async (tx) => {
    await assertActivePortalInboxIdentityTx(tx, { ...actor, requireUpload: true });
    const intent = await tx.portalInboxAttachment.findFirst({
      where: {
        id: attachmentId,
        tenantId: actor.tenantId,
        clientId: actor.clientId,
        batchId,
        batch: {
          createdByContactId: actor.contactId,
          status: 'OPEN',
          expiresAt: { gt: new Date() },
        },
      },
      select: {
        id: true,
        tenantId: true,
        originalName: true,
        mimeType: true,
        storageBucket: true,
        storageKey: true,
        storageVersionId: true,
        sha256: true,
        sizeBytes: true,
        scanStatus: true,
        decision: true,
      },
    });
    if (!intent || intent.decision !== 'PENDING_REVIEW') {
      throw new InboxUploadPolicyError('BATCH_UNAVAILABLE');
    }
    return intent;
  });
}

function assertResumeBytes(
  inspected: PreparedBytesCommit,
  intent: { sha256: Uint8Array; sizeBytes: bigint; mimeType: string },
): void {
  if (
    inspected.sizeBytes !== intent.sizeBytes ||
    !inspected.sha256.equals(Buffer.from(intent.sha256)) ||
    inspected.detectedMime !== intent.mimeType
  ) {
    throw new InboxUploadPolicyError('BATCH_UNAVAILABLE');
  }
}

async function finalizeIntent(
  actor: InboxUploadContext,
  batchId: string,
  attachmentId: string,
  commit: Awaited<ReturnType<typeof commitPreparedBytes>>,
): Promise<void> {
  await withTenantContext(actor.context, async (tx) => {
    await assertActivePortalInboxIdentityTx(tx, { ...actor, requireUpload: true });
    const finalized = await tx.portalInboxAttachment.updateMany({
      where: {
        id: attachmentId,
        tenantId: actor.tenantId,
        clientId: actor.clientId,
        batchId,
        storageBucket: commit.targetBucket,
        storageKey: commit.targetKey,
        scanStatus: 'PENDING',
        decision: 'PENDING_REVIEW',
        batch: {
          createdByContactId: actor.contactId,
          status: 'OPEN',
          expiresAt: { gt: new Date() },
        },
      },
      data: {
        storageVersionId: commit.storageVersionId,
        scanStatus: 'CLEAN',
      },
    });
    if (finalized.count === 1) return;
    const alreadyClean = await tx.portalInboxAttachment.findFirst({
      where: {
        id: attachmentId,
        batchId,
        storageBucket: commit.targetBucket,
        storageKey: commit.targetKey,
        scanStatus: 'CLEAN',
        decision: 'PENDING_REVIEW',
      },
      select: { id: true },
    });
    if (!alreadyClean) throw new InboxUploadPolicyError('BATCH_UNAVAILABLE');
  });
}

/**
 * Scannt zuerst, journalisiert danach die feste PENDING-Storageidentitaet und
 * schreibt erst dann das Objekt. `resumeAttachmentId` nimmt genau denselben
 * Intent nach einem Commit-/Finalize-Abbruch wieder auf.
 */
export async function stageInboxAttachment(input: {
  actor: InboxUploadContext;
  batchId: string;
  fileData: Buffer;
  originalName: string;
  resumeAttachmentId?: string | null;
}): Promise<InboxStagedAttachment> {
  let inspected: PreparedBytesCommit;
  try {
    inspected = await inspectInboxBytes(input.fileData, input.actor.tenantId);
  } catch (cause) {
    throw new InboxUploadError(input.resumeAttachmentId ? 'resume' : 'prepare', cause);
  }

  let attachmentId: string;
  let prepared: PreparedBytesCommit;
  let persistedName: string;
  if (input.resumeAttachmentId) {
    let intent;
    try {
      intent = await loadResumeIntent(input.actor, input.batchId, input.resumeAttachmentId);
      assertResumeBytes(inspected, intent);
    } catch (cause) {
      throw new InboxUploadError('resume', cause, input.resumeAttachmentId);
    }
    attachmentId = intent.id;
    persistedName = intent.originalName;
    prepared = preparedFromIntent(intent);
    if (intent.scanStatus === 'CLEAN') {
      return {
        attachmentId,
        originalName: persistedName,
        mimeType: intent.mimeType,
        sizeBytes: intent.sizeBytes.toString(),
        resumed: true,
      };
    }
  } else {
    prepared = inspected;
    persistedName = sanitizeInboxOriginalName(input.originalName);
    try {
      attachmentId = await journalNewIntent(input.actor, input.batchId, persistedName, prepared);
    } catch (cause) {
      throw new InboxUploadError('journal', cause);
    }
  }

  let commit;
  try {
    commit = await recoverPreparedBytesCommit(prepared);
    commit ??= await commitPreparedBytes({ fileData: input.fileData, prepared });
  } catch (cause) {
    throw new InboxUploadError('commit', cause, attachmentId);
  }

  try {
    await finalizeIntent(input.actor, input.batchId, attachmentId, commit);
  } catch (cause) {
    // Wurde der Batch parallel verworfen/gesperrt, ist das Objekt nicht mehr
    // fachlich referenzierbar. Das Recovery-Journal loescht es nachweisbar;
    // bei einem bloss transienten DB-Fehler bleibt dagegen der PENDING-Intent
    // fuer einen sicheren Retry erhalten.
    if (cause instanceof InboxUploadPolicyError && cause.code === 'BATCH_UNAVAILABLE') {
      await compensateStorageCommit({
        tenantId: input.actor.tenantId,
        source: 'portal-inbox-finalize-conflict',
        commit,
        cause,
      });
    }
    throw new InboxUploadError('finalize', cause, attachmentId);
  }

  return {
    attachmentId,
    originalName: persistedName,
    mimeType: prepared.detectedMime!,
    sizeBytes: prepared.sizeBytes.toString(),
    resumed: Boolean(input.resumeAttachmentId),
  };
}
