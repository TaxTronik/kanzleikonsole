// Commit für eine neue Version eines existierenden Dokuments.

// App-proxied Upload (kein presigned-direct): Browser POSTet multipart.
import { NextResponse, type NextRequest } from 'next/server';
import { getClientIp } from '@/server/rate-limit';
import { z } from 'zod';
import { staffAuth } from '@/server/auth/staff';
import { commitDocumentFromBytes, MAX_UPLOAD_BYTES } from '@taxtronik/storage';
import { withTenantContext } from '@taxtronik/db';
import { prismaBytes } from '@/server/db/prisma-bytes';
import { evidenceService } from '@/server/container';

const Schema = z.object({
  mimeType: z.string().min(1).max(255).default('application/octet-stream'),
  changeNote: z.string().max(500).optional().or(z.literal('')),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await staffAuth();
  if (!session?.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id: documentId } = await params;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'invalid_multipart' }, { status: 400 });
  }
  const file = form.get('file');
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: 'file_missing' }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: 'TOO_LARGE' }, { status: 413 });
  }
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
  const doc = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) =>
      tx.document.findFirst({
        where: { id: documentId, tenantId },
        include: { versions: { orderBy: { versionNo: 'desc' }, take: 1 } },
      }),
  );
  if (!doc) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const nextVersionNo = (doc.versions[0]?.versionNo ?? 0) + 1;

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
    const msg = (e as Error).message;
    const status =
      msg.startsWith('INFECTED') ? 422 :
      msg.startsWith('TOO_LARGE') ? 413 :
      msg.startsWith('FORBIDDEN') ? 403 :
      msg.startsWith('SCAN_ERROR') ? 502 : 500;
    return NextResponse.json({ error: msg }, { status });
  }

  await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
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
    },
  );

  return NextResponse.json({
    ok: true,
    versionNo: nextVersionNo,
    sha256: commit.sha256.toString('hex'),
  });
}
