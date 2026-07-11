// Commit für eine neue Version eines existierenden Dokuments.

// App-proxied Upload (kein presigned-direct): Browser POSTet multipart.
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@taxtronik/config';
import { getClientIp } from '@/server/rate-limit';
import { z } from 'zod';
import { staffAuth } from '@/server/auth/staff';
import { canAccessClientTx } from '@/server/auth/rbac';
import { assertSameOrigin } from '@/server/http/assert-same-origin';
import {
  classificationToTier,
  commitBytesWithTier,
  deleteObject,
  gobdRetentionYears,
  MAX_UPLOAD_BYTES,
  type ProtectionTier,
} from '@taxtronik/storage';
import { withTenantContext } from '@taxtronik/db';
import { prismaBytes } from '@/server/db/prisma-bytes';
import {
  parseMultipartUpload,
  storageCommitErrorResponse,
} from '@/server/documents/upload-helpers';
import { evidenceService } from '@/server/container';
import { log } from '@/server/logger';

const Schema = z.object({
  mimeType: z.string().min(1).max(255).default('application/octet-stream'),
  changeNote: z.string().max(500).optional().or(z.literal('')),
});

class PoaDocumentLockedError extends Error {}
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

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // CSRF-Defense-in-Depth (zusätzlich zu SameSite=lax): Cross-Origin-POSTs
  // ablehnen, bevor irgendetwas gepuffert oder authentifiziert wird.
  const csrf = assertSameOrigin(req, env.NEXTAUTH_URL);
  if (csrf) return csrf;

  const session = await staffAuth();
  if (!session?.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id: documentId } = await params;

  // DoS-Mitigation: ehrlich deklarierte Über-Größe ablehnen, BEVOR req.formData()
  // den gesamten Body in den RAM puffert (+1 MB Marge für Multipart-Framing +
  // Metadatenfelder) — identisch zu staff/documents/commit. Lügt der Client über
  // Content-Length oder nutzt chunked-Encoding, greift der file.size-Check in
  // parseMultipartUpload (dann ist gepuffert).
  const declaredLen = Number(req.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLen) && declaredLen > MAX_UPLOAD_BYTES + 1024 * 1024) {
    return NextResponse.json({ error: 'TOO_LARGE' }, { status: 413 });
  }

  // Befund 12: Multipart-Parse + Datei-Checks zentral (upload-helpers).
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

  // Existierendes Dokument lesen — Audit 4: expliziter Tenant-Filter.
  // (versionNo wird hier NICHT mehr ermittelt — siehe Befund 2 unten.)
  // Zugriffsmodell (vertraulich-Flag / RESTRICTED): Dokumente gesperrter
  // Mandanten wie „nicht gefunden" behandeln (kein Existenz-Leak).
  const loaded = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const d = await tx.document.findFirst({
        where: { id: documentId, tenantId, deletedAt: null },
        select: {
          id: true,
          clientId: true,
          classification: true,
          documentTypeId: true,
          documentType: { select: { tier: true, retentionYears: true } },
        },
      });
      if (!d) return null;
      if (d.clientId && !(await canAccessClientTx(tx, session, d.clientId))) return null;
      // Ab Versand ist die konkrete Dokumentversion Bestandteil des
      // Signatur-Snapshots. Neue Versionen sind deshalb ab SENT gesperrt.
      const boundPoa = await tx.powerOfAttorney.findFirst({
        where: {
          documentId,
          OR: [{ status: { in: ['SENT', 'SIGNED'] } }, { signingContentSnapshot: { not: null } }],
        },
        select: { id: true },
      });
      return { doc: d, lockedByPoa: !!boundPoa };
    },
  );
  if (!loaded) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (loaded.lockedByPoa) return lockedByPoaResponse();
  const doc = loaded.doc;

  // Storage-Commit (Scan + Upload, intern zu SeaweedFS)
  const fileData = Buffer.from(await file.arrayBuffer());
  let commit;
  try {
    const tier = (doc.documentType?.tier ??
      classificationToTier(doc.classification)) as ProtectionTier;
    const retentionYears =
      doc.documentType?.retentionYears ??
      (tier === 'GOBD' ? gobdRetentionYears(doc.classification) : null);
    commit = await commitBytesWithTier({
      fileData,
      tier,
      classification: doc.classification,
      tenantId,
      ...(tier === 'GOBD' && retentionYears ? { retentionYears } : {}),
    });
  } catch (e) {
    // Befund 12: Mapping zentral (war 3× wortgleich kopiert).
    return storageCommitErrorResponse(e);
  }

  // Befund 2: versionNo in DERSELBEN Tx ermitteln wie der Insert. Vorher lag
  // der Storage-Commit zwischen Read (eigene Tx) und Insert — zwei parallele
  // Uploads lasen dasselbe max(versionNo) und der zweite Insert starb mit
  // P2002 → 500. Das Restrace (zwei Tx lesen unter Read Committed dasselbe
  // Maximum) fängt der P2002-Handler unten als 409 ab.
  let versionNo: number;
  try {
    versionNo = await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        // TOCTOU-Gegenstück zur Vorprüfung: Ein Versand kann zwischen Upload
        // und DB-Insert stattfinden. Dann bleibt das Storage-Objekt verwaist,
        // die gebundene Dokumenthistorie aber unverändert.
        const lockedDocuments = await tx.$queryRaw<
          Array<{
            id: string;
            tenantId: string;
            clientId: string | null;
            classification: string;
            documentTypeId: string | null;
          }>
        >`
          SELECT
            id,
            tenant_id AS "tenantId",
            client_id AS "clientId",
            classification::text AS classification,
            document_type_id AS "documentTypeId"
          FROM document
          WHERE id = ${documentId}::uuid
            AND tenant_id = ${tenantId}::uuid
            AND deleted_at IS NULL
          FOR UPDATE
        `;
        const lockedDocument = lockedDocuments[0];
        if (
          !lockedDocument ||
          lockedDocument.tenantId !== tenantId ||
          lockedDocument.clientId !== (doc.clientId ?? null) ||
          lockedDocument.classification !== doc.classification ||
          lockedDocument.documentTypeId !== (doc.documentTypeId ?? null)
        ) {
          throw new DocumentReferenceChangedError();
        }
        if (lockedDocument.documentTypeId) {
          const lockedTypes = await tx.$queryRaw<
            Array<{ id: string; tier: string; retentionYears: number | null }>
          >`
            SELECT
              id,
              tier::text AS tier,
              retention_years AS "retentionYears"
            FROM document_type
            WHERE id = ${lockedDocument.documentTypeId}::uuid
              AND tenant_id = ${tenantId}::uuid
            FOR SHARE
          `;
          const lockedType = lockedTypes[0];
          if (
            !lockedType ||
            !doc.documentType ||
            lockedType.tier !== doc.documentType.tier ||
            lockedType.retentionYears !== doc.documentType.retentionYears
          ) {
            throw new DocumentReferenceChangedError();
          }
        }
        // Der vertrauliche/RESTRICTED-Zugriff kann waehrend des Storage-
        // Uploads entzogen worden sein. Vor dem Insert im aktuellen Zustand
        // erneut pruefen; die Dokumentzeilensperre stabilisiert zugleich
        // Soft-Delete, Retagging und Tenant/Client-Paarung.
        if (
          lockedDocument.clientId &&
          !(await canAccessClientTx(tx, session, lockedDocument.clientId))
        ) {
          throw new DocumentReferenceChangedError();
        }
        const boundPoa = await tx.powerOfAttorney.findFirst({
          where: {
            documentId,
            OR: [{ status: { in: ['SENT', 'SIGNED'] } }, { signingContentSnapshot: { not: null } }],
          },
          select: { id: true },
        });
        if (boundPoa) throw new PoaDocumentLockedError();
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
            sha256: prismaBytes(commit.sha256),
            sizeBytes: commit.sizeBytes,
            immutable: commit.immutable,
            scanStatus: 'CLEAN',
            scanCompletedAt: new Date(),
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
    );
  } catch (e) {
    // Wie Befund 1: das Objekt liegt bereits object-locked im Storage und
    // kann nicht gelöscht werden → verwaisten Key strukturiert loggen.
    log.error(
      {
        component: 'documents-new-version',
        tenantId,
        documentId,
        orphanedBucket: commit.targetBucket,
        orphanedKey: commit.targetKey,
        sha256: commit.sha256.toString('hex'),
        err: (e as Error).message,
      },
      'documents-new-version: DB-Commit nach Storage-Upload fehlgeschlagen — Objekt verwaist',
    );
    const rejectedBeforeInsert =
      e instanceof PoaDocumentLockedError ||
      e instanceof DocumentReferenceChangedError ||
      (e as { code?: string }).code === 'P2002';
    if (rejectedBeforeInsert) {
      // NONE-Objekte koennen sofort entfernt werden. Bei aktivem Object-Lock
      // wird S3 erwartungsgemaess ablehnen; das strukturierte Log haelt den
      // verwaisten Key dann fuer den spaeteren Abgleich fest.
      try {
        await deleteObject(commit.targetBucket, commit.targetKey);
      } catch (cleanupError) {
        log.error(
          {
            component: 'documents-new-version',
            tenantId,
            documentId,
            orphanedBucket: commit.targetBucket,
            orphanedKey: commit.targetKey,
            cleanupErr: (cleanupError as Error).message,
          },
          'documents-new-version: Kompensationsloeschung des verwaisten Objekts fehlgeschlagen',
        );
      }
    }
    if (e instanceof PoaDocumentLockedError) return lockedByPoaResponse();
    if (e instanceof DocumentReferenceChangedError) {
      return NextResponse.json(
        {
          error: 'reference_changed',
          message: 'Dokument oder Zugriffsberechtigung hat sich waehrend des Uploads geaendert.',
        },
        { status: 409 },
      );
    }
    if ((e as { code?: string }).code === 'P2002') {
      return NextResponse.json(
        {
          error: 'version_conflict',
          message: 'Gleichzeitiger Upload einer neuen Version erkannt. Bitte erneut versuchen.',
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    versionNo,
    sha256: commit.sha256.toString('hex'),
  });
}
