// Commit für eine neue Version eines existierenden Dokuments.

// App-proxied Upload (kein presigned-direct): Browser POSTet multipart.
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@taxtronik/config';
import { getClientIp } from '@/server/rate-limit';
import { z } from 'zod';
import { staffAuth } from '@/server/auth/staff';
import { assertSameOrigin } from '@/server/http/assert-same-origin';
import { commitDocumentFromBytes } from '@taxtronik/storage';
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

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // CSRF-Defense-in-Depth (zusätzlich zu SameSite=lax): Cross-Origin-POSTs
  // ablehnen, bevor irgendetwas gepuffert oder authentifiziert wird.
  const csrf = assertSameOrigin(req, env.NEXTAUTH_URL);
  if (csrf) return csrf;

  const session = await staffAuth();
  if (!session?.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id: documentId } = await params;

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
  const doc = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) => tx.document.findFirst({ where: { id: documentId, tenantId } }),
  );
  if (!doc) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // Storage-Commit (Scan + Upload, intern zu SeaweedFS)
  const fileData = Buffer.from(await file.arrayBuffer());
  let commit;
  try {
    commit = await commitDocumentFromBytes({
      fileData,
      classification: doc.classification,
      tenantId,
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
