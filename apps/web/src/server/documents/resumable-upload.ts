import type { Prisma } from '@prisma/client';
import {
  commitPreparedBytes,
  prepareBytesCommitWithTier,
  recoverPreparedBytesCommit,
  type PreparedBytesCommit,
  type ProtectionTier,
} from '@taxtronik/storage';
import { withTenantContext, type TenantContext, type TxClient } from '@taxtronik/db';
import {
  createPendingDocumentWithVersion,
  finalizePendingDocumentVersion,
} from '@/server/documents/upload-helpers';

export type ResumableDocumentUploadPhase = 'prepare' | 'resume' | 'journal' | 'commit' | 'finalize';

export type ResumableDocumentUploadInvariant =
  | 'TENANT_CONTEXT_MISMATCH'
  | 'PREPARED_TENANT_MISMATCH'
  | 'RESUME_NOT_FOUND'
  | 'RESUME_NOT_RESUMABLE'
  | 'RESUME_INVALID_STATUS';

/**
 * Technische Invarianten der wiederaufnehmbaren Upload-Maschine. Aufrufer
 * duerfen die Codes in ihre fachlichen/UI-spezifischen Meldungen uebersetzen.
 */
export class ResumableDocumentUploadInvariantError extends Error {
  constructor(readonly code: ResumableDocumentUploadInvariant) {
    super(code);
    this.name = 'ResumableDocumentUploadInvariantError';
  }
}

/**
 * Markiert die Phase, in der der Upload angehalten wurde. Ab Journal/Commit
 * enthaelt `pendingDocumentId` die stabile ID, mit der sicher fortgesetzt wird.
 */
export class ResumableDocumentUploadError extends Error {
  override readonly cause: unknown;

  constructor(
    readonly phase: ResumableDocumentUploadPhase,
    cause: unknown,
    readonly pendingDocumentId?: string,
  ) {
    super(cause instanceof Error ? cause.message : `DOCUMENT_UPLOAD_${phase.toUpperCase()}_FAILED`);
    this.name = 'ResumableDocumentUploadError';
    this.cause = cause;
  }
}

export interface ResumableDocumentUploadOptions {
  context: TenantContext;
  resumeDocumentId?: string | null;
  documentData: Prisma.DocumentUncheckedCreateInput;
  resumeWhere: Prisma.DocumentWhereInput;
  createdById: string;
  storage: {
    tier: ProtectionTier;
    classification?: string;
    skipScan?: boolean;
    retentionYears?: number;
    retentionAnchor?: Date;
    /** MIME-Typ, der beim Wiederaufbau eines PENDING-Intents verwendet wird. */
    expectedMime: string | null;
  };
  readBytes: () => Promise<Buffer>;
  validatePrepared?: (prepared: PreparedBytesCommit) => void | Promise<void>;
  /** Fachlicher Context-Guard; laeuft atomar mit Resume bzw. PENDING-Journal. */
  guardMutationTx: (tx: TxClient) => Promise<void>;
  /** Fachliche Reservierung, z. B. dass das Dokument noch keiner PoA gehoert. */
  assertDocumentAvailableTx?: (tx: TxClient, documentId: string) => Promise<void>;
  recordPendingTx?: (
    tx: TxClient,
    upload: { documentId: string; versionId: string },
  ) => Promise<unknown>;
  recordCompleteTx?: (
    tx: TxClient,
    upload: { documentId: string; versionId: string },
  ) => Promise<unknown>;
}

export interface ResumableDocumentUpload {
  documentId: string;
  versionId: string;
  source: 'created' | 'resumed-pending' | 'resumed-clean';
}

interface ResumedUpload extends ResumableDocumentUpload {
  prepared: PreparedBytesCommit | null;
}

function uploadResult(upload: ResumedUpload): ResumableDocumentUpload {
  return {
    documentId: upload.documentId,
    versionId: upload.versionId,
    source: upload.source,
  };
}

async function loadResumableUpload(
  options: ResumableDocumentUploadOptions,
  documentId: string,
): Promise<ResumedUpload> {
  const tenantId = options.context.tenantId;
  return withTenantContext(options.context, async (tx) => {
    await options.guardMutationTx(tx);
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
        FROM "document"
       WHERE "id" = ${documentId}::uuid
         AND "tenant_id" = ${tenantId}::uuid
       FOR UPDATE
    `;
    if (!locked[0]) {
      throw new ResumableDocumentUploadInvariantError('RESUME_NOT_FOUND');
    }

    // `id` und `tenantId` stehen bewusst nach dem fachlichen Filter. Ein
    // Aufrufer kann die beiden Tenant-Grenzen dadurch nicht ueberschreiben.
    const document = await tx.document.findFirst({
      where: { ...options.resumeWhere, id: documentId, tenantId },
      select: {
        id: true,
        retentionUntil: true,
        versions: {
          orderBy: { versionNo: 'desc' },
          take: 2,
          select: {
            id: true,
            versionNo: true,
            storageBucket: true,
            storageKey: true,
            storageVersionId: true,
            sha256: true,
            sizeBytes: true,
            immutable: true,
            scanStatus: true,
            scanCompletedAt: true,
          },
        },
      },
    });
    const immutable = options.storage.tier !== 'NONE';
    const retentionMatchesTier = immutable
      ? document?.retentionUntil != null
      : document?.retentionUntil == null;
    if (!document || document.versions.length !== 1 || !retentionMatchesTier) {
      throw new ResumableDocumentUploadInvariantError('RESUME_NOT_RESUMABLE');
    }

    await options.assertDocumentAvailableTx?.(tx, document.id);

    const version = document.versions[0]!;
    if (version.versionNo !== 1 || version.immutable !== immutable) {
      throw new ResumableDocumentUploadInvariantError('RESUME_NOT_RESUMABLE');
    }
    const clean =
      version.scanStatus === 'CLEAN' &&
      version.scanCompletedAt !== null &&
      (!immutable || Boolean(version.storageVersionId?.trim()));
    const pending =
      version.scanStatus === 'PENDING' &&
      version.scanCompletedAt === null &&
      version.storageVersionId === null;
    if (!clean && !pending) {
      throw new ResumableDocumentUploadInvariantError('RESUME_INVALID_STATUS');
    }

    return {
      documentId: document.id,
      versionId: version.id,
      source: clean ? 'resumed-clean' : 'resumed-pending',
      prepared: pending
        ? {
            tier: options.storage.tier,
            tenantId,
            targetBucket: version.storageBucket,
            targetKey: version.storageKey,
            sha256: Buffer.from(version.sha256),
            sizeBytes: version.sizeBytes,
            immutable,
            retentionUntil: document.retentionUntil,
            detectedMime: options.storage.expectedMime,
          }
        : null,
    };
  });
}

/**
 * Generische Zwei-Phasen-Orchestrierung fuer geschuetzte Dokument-Uploads:
 *
 * 1. Bytes pruefen und festen Storage-Key vorbereiten (noch kein Object-Write)
 * 2. PENDING-Document + Version atomar journalisieren oder vorhandenes Journal
 *    unter Tenant-Lock wiederaufnehmen
 * 3. exakt den vorbereiteten Key recovern/committen
 * 4. dieselbe Version in einer separaten Transaktion auf CLEAN finalisieren
 *
 * Nach Commit-/Finalize-Fehlern bleibt absichtlich die PENDING-Spur erhalten.
 * Das ist die Cleanup-Strategie: kein unveraenderbares Objekt wird unsichtbar
 * geloescht; der stabile Intent wird beim naechsten Aufruf inventarisiert.
 */
export async function persistResumableDocumentUpload(
  options: ResumableDocumentUploadOptions,
): Promise<ResumableDocumentUpload> {
  const tenantId = options.context.tenantId;
  const suppliedTenantId = options.documentData.tenantId;
  if (suppliedTenantId !== tenantId) {
    const phase = options.resumeDocumentId ? 'resume' : 'prepare';
    throw new ResumableDocumentUploadError(
      phase,
      new ResumableDocumentUploadInvariantError('TENANT_CONTEXT_MISMATCH'),
      options.resumeDocumentId ?? undefined,
    );
  }

  let upload: ResumedUpload;
  if (options.resumeDocumentId) {
    try {
      upload = await loadResumableUpload(options, options.resumeDocumentId);
    } catch (cause) {
      throw new ResumableDocumentUploadError('resume', cause, options.resumeDocumentId);
    }
  } else {
    let fileData: Buffer;
    let prepared: PreparedBytesCommit;
    try {
      fileData = await options.readBytes();
      prepared = await prepareBytesCommitWithTier({
        fileData,
        tier: options.storage.tier,
        tenantId,
        classification: options.storage.classification,
        skipScan: options.storage.skipScan,
        retentionYears: options.storage.retentionYears,
        retentionAnchor: options.storage.retentionAnchor,
      });
      if (prepared.tenantId !== tenantId) {
        throw new ResumableDocumentUploadInvariantError('PREPARED_TENANT_MISMATCH');
      }
      await options.validatePrepared?.(prepared);
    } catch (cause) {
      throw new ResumableDocumentUploadError('prepare', cause);
    }

    try {
      const pending = await withTenantContext(options.context, async (tx) => {
        await options.guardMutationTx(tx);
        const created = await createPendingDocumentWithVersion(tx, {
          documentData: { ...options.documentData, tenantId },
          prepared,
          createdById: options.createdById,
        });
        const journal = {
          documentId: created.document.id,
          versionId: created.version.id,
        };
        await options.recordPendingTx?.(tx, journal);
        return journal;
      });
      upload = { ...pending, source: 'created', prepared };
    } catch (cause) {
      throw new ResumableDocumentUploadError('journal', cause);
    }

    // Der bereits gelesene Buffer wird nur im neuen Pfad wiederverwendet. Der
    // Resume-Pfad liest erst dann erneut, wenn im Object Store nichts liegt.
    return commitAndFinalize(options, upload, fileData);
  }

  if (!upload.prepared) {
    return uploadResult(upload);
  }
  return commitAndFinalize(options, upload);
}

async function commitAndFinalize(
  options: ResumableDocumentUploadOptions,
  upload: ResumedUpload,
  initialBytes?: Buffer,
): Promise<ResumableDocumentUpload> {
  let committed;
  try {
    committed =
      upload.source === 'resumed-pending'
        ? await recoverPreparedBytesCommit(upload.prepared!)
        : null;
    if (!committed) {
      const fileData = initialBytes ?? (await options.readBytes());
      committed = await commitPreparedBytes({ fileData, prepared: upload.prepared! });
    }
  } catch (cause) {
    throw new ResumableDocumentUploadError('commit', cause, upload.documentId);
  }

  try {
    await withTenantContext(options.context, async (tx) => {
      await finalizePendingDocumentVersion(tx, {
        documentId: upload.documentId,
        versionId: upload.versionId,
        commit: committed,
      });
      await options.recordCompleteTx?.(tx, upload);
    });
  } catch (cause) {
    throw new ResumableDocumentUploadError('finalize', cause, upload.documentId);
  }

  return uploadResult(upload);
}
