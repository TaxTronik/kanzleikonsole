// =============================================================================
// Gemeinsame Upload-Bausteine für die Dokument-Commit-Pfade (Befund 12).
//
// Vorher 3–4× wortgleich kopiert in:
//   • POST /api/staff/documents/commit
//   • POST /api/staff/documents/[id]/new-version/commit
//   • POST /api/portal/documents/commit
//   • gwg-onboarding/actions.ts + invoices/actions.ts (Document+Version-Insert)
//
// Streng verhaltensneutral: Routen-Spezifika (Portal-Sharing, folderId,
// Klassifikations-Auflösung, Audit-Inhalte) bleiben beim Aufrufer — hier
// liegen nur die identischen Blöcke.
// =============================================================================

import { NextResponse, type NextRequest } from 'next/server';
import type { Prisma } from '@prisma/client';
import type { TxClient } from '@taxtronik/db';
import {
  MAX_UPLOAD_BYTES,
  type CommitDocumentResult,
  type PreparedBytesCommit,
} from '@taxtronik/storage';
import { prismaBytes } from '@/server/db/prisma-bytes';
import { log } from '@/server/logger';

/**
 * Multipart-Parse + Datei-Checks (identisch in allen drei Commit-Routen).
 * Discriminated Union: bei `ok: false` die fertige Fehler-Response zurückgeben.
 */
export type ParsedUpload =
  | { ok: true; form: FormData; file: Blob }
  | { ok: false; response: NextResponse };

export async function parseMultipartUpload(req: NextRequest): Promise<ParsedUpload> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: 'invalid_multipart' }, { status: 400 }),
    };
  }
  const file = form.get('file');
  if (!(file instanceof Blob)) {
    return { ok: false, response: NextResponse.json({ error: 'file_missing' }, { status: 400 }) };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, response: NextResponse.json({ error: 'TOO_LARGE' }, { status: 413 }) };
  }
  return { ok: true, form, file };
}

/**
 * Storage-Commit-Fehler (ClamAV/Größe/Policy) → HTTP-Response.
 * Mapping war 3× wortgleich kopiert; Message-Präfixe sind der Vertrag aus
 * @taxtronik/storage (commitDocumentFromBytes / commitBytesWithTier).
 */
export function storageCommitErrorResponse(e: unknown): NextResponse {
  const msg = (e as Error).message;
  const status = msg.startsWith('INFECTED')
    ? 422
    : msg.startsWith('TOO_LARGE')
      ? 413
      : msg.startsWith('FORBIDDEN')
        ? 403
        : msg.startsWith('SCAN_ERROR')
          ? 502
          : 500;
  if (status === 500) {
    // Unbekannte Errors NIE roh ans UI (Policy, siehe rbac.ts) — die Route wird
    // auch vom Mandanten-Portal genutzt; ein ECONNREFUSED-Text würde interne
    // Netz-Topologie an externe Clients leaken. Details nur ins Server-Log.
    log.error({ err: msg }, 'storage-commit: unerwarteter Fehler');
    return NextResponse.json({ error: 'storage_error' }, { status });
  }
  return NextResponse.json({ error: msg }, { status });
}

/**
 * Document + erste DocumentVersion (versionNo 1, CLEAN) aus einem
 * Storage-Commit anlegen. `documentData` trägt die aufruferspezifischen
 * Felder (clientId, classification, retentionUntil, sharedWithClientAt, …).
 */
export async function createDocumentWithVersion(
  tx: TxClient,
  opts: {
    documentData: Prisma.DocumentUncheckedCreateInput;
    commit: Pick<
      CommitDocumentResult,
      | 'targetBucket'
      | 'targetKey'
      | 'storageVersionId'
      | 'sha256'
      | 'sizeBytes'
      | 'immutable'
      | 'retentionUntil'
    >;
    /** Staff-ID bzw. Contact-ID, die die Version erfasst hat. */
    createdById: string;
  },
) {
  const document = await tx.document.create({
    data: {
      ...opts.documentData,
      // Die Storage-Schicht ist die einzige Quelle für die tatsächlich am
      // Objekt gesetzte Frist. Jeder Uploadpfad muss exakt diesen Wert in den
      // Dokumentmetadaten verankern; Aufrufer dürfen ihn nicht vergessen oder
      // abweichend neu berechnen.
      retentionUntil: opts.commit.retentionUntil,
    },
  });
  const version = await tx.documentVersion.create({
    data: {
      documentId: document.id,
      versionNo: 1,
      storageBucket: opts.commit.targetBucket,
      storageKey: opts.commit.targetKey,
      storageVersionId: opts.commit.storageVersionId,
      sha256: prismaBytes(opts.commit.sha256),
      sizeBytes: opts.commit.sizeBytes,
      immutable: opts.commit.immutable,
      scanStatus: 'CLEAN',
      scanCompletedAt: new Date(),
      createdById: opts.createdById,
    },
  });
  return { document, version };
}

/**
 * Persistiert die auffindbare Upload-Absicht vor einem geschützten S3-Write.
 * Der feste Bucket/Key und der erwartete Hash bleiben dadurch auch bei einem
 * Prozessabbruch oder einer später zurückgerollten Fachtransaktion erhalten.
 */
export async function createPendingDocumentWithVersion(
  tx: TxClient,
  opts: {
    documentData: Prisma.DocumentUncheckedCreateInput;
    prepared: PreparedBytesCommit;
    createdById: string;
  },
) {
  const document = await tx.document.create({
    data: {
      ...opts.documentData,
      retentionUntil: opts.prepared.retentionUntil,
    },
  });
  const version = await tx.documentVersion.create({
    data: {
      documentId: document.id,
      versionNo: 1,
      storageBucket: opts.prepared.targetBucket,
      storageKey: opts.prepared.targetKey,
      storageVersionId: null,
      sha256: prismaBytes(opts.prepared.sha256),
      sizeBytes: opts.prepared.sizeBytes,
      // Die PENDING-Zeile ist bereits immutable: Bucket, Key und Hash dürfen
      // zwischen Journal und Object-Store-Write nie umgebogen werden. Eine DB-
      // Constraint/Trigger-Ausnahme erlaubt ausschließlich den engen Übergang
      // PENDING/null -> CLEAN/storageVersionId bei identischer Storage-Identität.
      immutable: opts.prepared.immutable,
      scanStatus: 'PENDING',
      scanCompletedAt: null,
      createdById: opts.createdById,
    },
  });
  return { document, version };
}

/** Finalisiert ausschließlich genau die zuvor persistierte PENDING-Version. */
export async function finalizePendingDocumentVersion(
  tx: TxClient,
  opts: {
    documentId: string;
    versionId: string;
    commit: CommitDocumentResult;
  },
): Promise<void> {
  if (opts.commit.immutable && !opts.commit.storageVersionId) {
    throw new Error('DOCUMENT_UPLOAD_VERSION_MISSING');
  }
  const finalized = await tx.documentVersion.updateMany({
    where: {
      id: opts.versionId,
      documentId: opts.documentId,
      storageBucket: opts.commit.targetBucket,
      storageKey: opts.commit.targetKey,
      scanStatus: 'PENDING',
      immutable: opts.commit.immutable,
    },
    data: {
      storageVersionId: opts.commit.storageVersionId,
      immutable: opts.commit.immutable,
      scanStatus: 'CLEAN',
      scanCompletedAt: new Date(),
    },
  });
  if (finalized.count !== 1) {
    throw new Error('DOCUMENT_UPLOAD_FINALIZE_CONFLICT');
  }
}
