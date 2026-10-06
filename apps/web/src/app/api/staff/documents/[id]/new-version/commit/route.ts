// Commit für eine neue Version eines existierenden Dokuments.

// App-proxied Upload (kein presigned-direct): Browser POSTet multipart.
//
// Journal-first (K-06 / DOC-UPLOAD-JOURNAL-001): dieselbe Prüfung des
// Zieldokuments läuft vor Scan, Journal und Object-Write und erneut unter
// Zeilensperre in der Commit-Transaktion. Die Speicherabsicht steht vor dem
// PUT im Journal und wird mit dem Versionsinsert atomar abgeschlossen.
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@taxtronik/config';
import { getClientIp } from '@/server/rate-limit';
import { z } from 'zod';
import { staffAuth, type StaffSession } from '@/server/auth/staff';
import { canAccessClientTx } from '@/server/auth/rbac';
import { assertSameOrigin } from '@/server/http/assert-same-origin';
import { classificationToTier, gobdRetentionYears, type ProtectionTier } from '@taxtronik/storage';
import type { TxClient } from '@taxtronik/db';
import { prismaBytes } from '@/server/db/prisma-bytes';
import {
  parseMultipartUpload,
  storageCommitErrorResponse,
} from '@/server/documents/upload-helpers';
import { JournaledUploadError, runJournaledUpload } from '@/server/documents/journaled-upload';
import { evidenceService } from '@/server/container';
import { identityPdfPageCountForUpload } from '@/server/gwg/identity-pdf-pages';
import { log } from '@/server/logger';

const Schema = z.object({
  mimeType: z.string().min(1).max(255).default('application/octet-stream'),
  changeNote: z.string().max(500).optional().or(z.literal('')),
});

class DocumentNotFoundError extends Error {}
class PoaDocumentLockedError extends Error {}
class GwgEvidenceLockedError extends Error {}
class DocumentReferenceChangedError extends Error {}

const lockedByPoaResponse = () =>
  NextResponse.json(
    {
      error: 'locked_by_poa',
      message:
        'Dieses Dokument ist an eine versendete oder unterschriebene Vollmacht gebunden und kann nicht mehr geändert werden.',
    },
    { status: 409 },
  );

const lockedByGwgResponse = () =>
  NextResponse.json(
    {
      error: 'locked_by_gwg_snapshot',
      message:
        'Dieser Nachweis ist bereits einer GwG-Prüfung zugeordnet und unveränderlich. Bitte ein neues Dokument hochladen und ausdrücklich neu zuordnen.',
    },
    { status: 409 },
  );

/** Geprüfter Stand des Zieldokuments (Vor- und Nachprüfung). */
interface NewVersionCheck {
  clientId: string | null;
  classification: string;
  documentTypeId: string | null;
  typeTier: string | null;
  typeRetentionYears: number | null;
}

/**
 * Gemeinsame Vor- und Nachprüfung (K-06). Die Dokumentzeilensperre
 * stabilisiert Soft-Delete, Retagging und Tenant/Client-Paarung; der Typ ist
 * Teil der Storage-/Retention-Entscheidung und wird FOR SHARE gelesen. In der
 * Commit-Transaktion muss der Stand der Vorprüfung unverändert sein — ein
 * Versand kann zwischen Upload und DB-Insert stattfinden.
 */
async function checkNewVersionTx(
  tx: TxClient,
  session: StaffSession,
  documentId: string,
  pre?: NewVersionCheck,
): Promise<NewVersionCheck> {
  const tenantId = session.user.tenantId;
  // Zugriffsmodell (vertraulich-Flag / RESTRICTED): Dokumente gesperrter
  // Mandanten wie „nicht gefunden" behandeln (kein Existenz-Leak); nach der
  // Vorprüfung gilt jede Abweichung als geänderte Referenz.
  const unavailable = () =>
    pre ? new DocumentReferenceChangedError() : new DocumentNotFoundError();
  const lockedDocuments = await tx.$queryRaw<
    Array<{
      id: string;
      tenantId: string;
      clientId: string | null;
      classification: string;
      documentTypeId: string | null;
      lockedByGwg: boolean;
    }>
  >`
    SELECT
      d.id,
      d.tenant_id AS "tenantId",
      d.client_id AS "clientId",
      d.classification::text AS classification,
      d.document_type_id AS "documentTypeId",
      EXISTS (
        SELECT 1
          FROM gwg_id_document gid
         WHERE gid.document_id = d.id
      ) AS "lockedByGwg"
    FROM document d
    WHERE d.id = ${documentId}::uuid
      AND d.tenant_id = ${tenantId}::uuid
      AND d.deleted_at IS NULL
    FOR UPDATE OF d
  `;
  const locked = lockedDocuments[0];
  if (!locked || locked.tenantId !== tenantId) throw unavailable();
  if (
    pre &&
    (locked.clientId !== pre.clientId ||
      locked.classification !== pre.classification ||
      locked.documentTypeId !== pre.documentTypeId)
  ) {
    throw new DocumentReferenceChangedError();
  }
  // Der vertrauliche/RESTRICTED-Zugriff kann waehrend des Storage-Uploads
  // entzogen worden sein; deshalb in beiden Phasen im aktuellen Zustand.
  if (locked.clientId && !(await canAccessClientTx(tx, session, locked.clientId))) {
    throw unavailable();
  }
  if (locked.lockedByGwg) throw new GwgEvidenceLockedError();

  let typeTier: string | null = null;
  let typeRetentionYears: number | null = null;
  if (locked.documentTypeId) {
    const lockedTypes = await tx.$queryRaw<
      Array<{ id: string; tier: string; retentionYears: number | null }>
    >`
      SELECT
        id,
        tier::text AS tier,
        retention_years AS "retentionYears"
      FROM document_type
      WHERE id = ${locked.documentTypeId}::uuid
        AND tenant_id = ${tenantId}::uuid
      FOR SHARE
    `;
    const lockedType = lockedTypes[0];
    if (
      !lockedType ||
      (pre &&
        (lockedType.tier !== pre.typeTier || lockedType.retentionYears !== pre.typeRetentionYears))
    ) {
      throw new DocumentReferenceChangedError();
    }
    typeTier = lockedType.tier;
    typeRetentionYears = lockedType.retentionYears;
  }

  // Ab Versand ist die konkrete Dokumentversion Bestandteil des
  // Signatur-Snapshots. Neue Versionen sind deshalb ab SENT gesperrt.
  const boundPoa = await tx.powerOfAttorney.findFirst({
    where: {
      documentId,
      OR: [{ status: { in: ['SENT', 'SIGNED'] } }, { signingContentSnapshot: { not: null } }],
    },
    select: { id: true },
  });
  if (boundPoa) throw new PoaDocumentLockedError();

  return {
    clientId: locked.clientId,
    classification: locked.classification,
    documentTypeId: locked.documentTypeId,
    typeTier,
    typeRetentionYears,
  };
}

function storageFor(checked: NewVersionCheck) {
  const tier = (checked.typeTier ?? classificationToTier(checked.classification)) as ProtectionTier;
  const retentionYears =
    checked.typeRetentionYears ??
    (tier === 'GOBD' ? gobdRetentionYears(checked.classification) : null);
  return {
    tier,
    classification: checked.classification,
    ...(tier === 'GOBD' && retentionYears ? { retentionYears } : {}),
  };
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // CSRF-Defense-in-Depth (zusätzlich zu SameSite=lax): Cross-Origin-POSTs
  // ablehnen, bevor irgendetwas gepuffert oder authentifiziert wird.
  const csrf = assertSameOrigin(req, env.NEXTAUTH_URL);
  if (csrf) return csrf;

  const session = await staffAuth();
  if (!session?.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id: documentId } = await params;

  // Multipart-Body wird zentral am echten Stream begrenzt; das greift auch
  // ohne Content-Length und bei chunked Transfer-Encoding.
  const upload = await parseMultipartUpload(req);
  if (!upload.ok) return upload.response;
  const { form, file } = upload;

  const parsed = Schema.safeParse({
    mimeType: form.get('mimeType') ?? undefined,
    changeNote: form.get('changeNote') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'validation' }, { status: 400 });
  }

  const { tenantId, staffId } = session.user;
  const { changeNote } = parsed.data;
  // P-13: Seitenzahl einer noch nicht zugeordneten PDF-Ausweisquelle (nur
  // GWG_EVIDENCE) einmalig aus genau diesen Bytes — nach dem Scan, vor dem
  // Object-Write.
  let pdfPageCount: number | null = null;

  let stored;
  try {
    stored = await runJournaledUpload({
      context: { tenantId, actorId: staffId, actorType: 'STAFF' },
      source: 'staff.document.new_version',
      check: (tx: TxClient, _phase: 'pre' | 'post', pre?: NewVersionCheck) =>
        checkNewVersionTx(tx, session, documentId, pre),
      readBytes: async () => Buffer.from(await file.arrayBuffer()),
      storage: storageFor,
      afterPrepare: async ({ bytes, checked }) => {
        pdfPageCount = await identityPdfPageCountForUpload({
          classification: checked.classification,
          mimeType: parsed.data.mimeType,
          bytes,
        });
      },
      commitTx: async (tx, { commit }) => {
        // Befund 2: versionNo in DERSELBEN Tx ermitteln wie der Insert. Das
        // Restrace (zwei Tx lesen unter Read Committed dasselbe Maximum) fängt
        // der P2002-Handler als 409 ab; die Dokumentzeilensperre der
        // Nachprüfung serialisiert parallele Uploads zusätzlich.
        const latest = await tx.documentVersion.findFirst({
          where: { documentId },
          orderBy: { versionNo: 'desc' },
          select: { versionNo: true },
        });
        const nextVersionNo = (latest?.versionNo ?? 0) + 1;
        const v = await tx.documentVersion.create({
          data: {
            documentId,
            versionNo: nextVersionNo,
            storageBucket: commit.targetBucket,
            storageKey: commit.targetKey,
            storageVersionId: commit.storageVersionId,
            sha256: prismaBytes(commit.sha256),
            sizeBytes: commit.sizeBytes,
            immutable: commit.immutable,
            scanStatus: 'CLEAN',
            scanCompletedAt: new Date(),
            pdfPageCount,
            createdById: staffId,
          },
        });
        if (commit.retentionUntil) {
          // § 147 Abs. 3 AO: eine neue Eintragung/Version kann die Frist neu
          // ankern. Metadaten nur monoton verlängern; nie eine bestehende
          // längere Object-Lock-Frist scheinbar verkürzen.
          await tx.document.updateMany({
            where: {
              id: documentId,
              OR: [{ retentionUntil: null }, { retentionUntil: { lt: commit.retentionUntil } }],
            },
            data: { retentionUntil: commit.retentionUntil },
          });
        }
        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'document.version.add',
          resourceType: 'document_version',
          resourceId: v.id,
          after: {
            documentId,
            versionNo: nextVersionNo,
            sha256: commit.sha256.toString('hex'),
            immutable: commit.immutable,
            changeNote: changeNote || null,
            retentionUntil: commit.retentionUntil?.toISOString() ?? null,
          },
          ip: getClientIp(req.headers),
          userAgent: req.headers.get('user-agent'),
        });
        return nextVersionNo;
      },
    });
  } catch (e) {
    return uploadErrorResponse(e, tenantId);
  }

  return NextResponse.json({
    ok: true,
    versionNo: stored.result,
    sha256: stored.commit.sha256.toString('hex'),
  });
}

function uploadErrorResponse(error: unknown, tenantId: string): NextResponse {
  const phase = error instanceof JournaledUploadError ? error.phase : null;
  const cause = error instanceof JournaledUploadError ? error.cause : error;
  if (phase === 'prepare' || phase === 'store') {
    // Befund 12: Mapping zentral (war 3× wortgleich kopiert).
    return storageCommitErrorResponse(cause);
  }
  if (cause instanceof DocumentNotFoundError) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (cause instanceof PoaDocumentLockedError) return lockedByPoaResponse();
  const gwgEvidenceLocked =
    cause instanceof GwgEvidenceLockedError ||
    (cause instanceof Error && cause.message.includes('Zugeordneter GwG-Beweisinhalt'));
  if (gwgEvidenceLocked) return lockedByGwgResponse();
  if (cause instanceof DocumentReferenceChangedError) {
    return NextResponse.json(
      {
        error: 'reference_changed',
        message: 'Dokument oder Zugriffsberechtigung hat sich waehrend des Uploads geaendert.',
      },
      { status: 409 },
    );
  }
  if (phase === 'commit' && (cause as { code?: string }).code === 'P2002') {
    return NextResponse.json(
      {
        error: 'version_conflict',
        message: 'Gleichzeitiger Upload einer neuen Version erkannt. Bitte erneut versuchen.',
      },
      { status: 409 },
    );
  }
  // Nach dem Object-Write bleibt die Speicherabsicht offen; der Cleanup-Worker
  // räumt das Objekt nach der Sicherheitsfrist versionsgenau auf.
  log.error(
    { component: 'documents-new-version', tenantId, phase, err: (cause as Error)?.message ?? null },
    'documents-new-version: Upload fehlgeschlagen',
  );
  return NextResponse.json({ error: 'internal_error' }, { status: 500 });
}
