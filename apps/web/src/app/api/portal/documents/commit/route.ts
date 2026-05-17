// App-proxied Upload (kein presigned-direct): Browser POSTet multipart,
// die App streamt intern zu SeaweedFS. Object-Store nie öffentlich.
import { NextResponse, type NextRequest } from 'next/server';
import { getClientIp } from '@/server/rate-limit';
import { z } from 'zod';
import { portalAuth } from '@/server/auth/portal';
import { commitDocumentFromBytes, MAX_UPLOAD_BYTES } from '@taxtronik/storage';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { emitN8nEvent } from '@/server/n8n/emit';

const Schema = z.object({
  title: z.string().min(1).max(500),
  mimeType: z.string().min(1).max(255).default('application/octet-stream'),
});

export async function POST(req: NextRequest) {
  const session = await portalAuth();
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

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
    title: form.get('title'),
    mimeType: form.get('mimeType') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { tenantId, contactId, clientId } = session.user;
  const { title, mimeType } = parsed.data;

  // F2: Feature-Flag-Guard für Portal-Document-Upload.
  const { assertPortalFeature } = await import('@/server/settings/portal-features');
  try {
    await assertPortalFeature(
      { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' },
      'documentUpload',
    );
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 403 });
  }

  const fileData = Buffer.from(await file.arrayBuffer());

  let commit;
  try {
    commit = await commitDocumentFromBytes({ fileData, classification: 'GENERAL', tenantId });
  } catch (e) {
    const msg = (e as Error).message;
    const status =
      msg.startsWith('INFECTED') ? 422 :
      msg.startsWith('TOO_LARGE') ? 413 :
      msg.startsWith('FORBIDDEN') ? 403 :
      msg.startsWith('SCAN_ERROR') ? 502 : 500;
    return NextResponse.json({ error: msg }, { status });
  }

  // M-2: Magic-Bytes-Detection schlägt Client-gemeldete mimeType, wenn ein
  // bekanntes Format erkannt wurde. Ein User, der text/html als image/jpeg
  // deklariert, bekommt jetzt die echte MIME gespeichert; Preview-Route
  // serviert dann mit dem echten Type (preview-mime-Whitelist greift trotzdem).
  const effectiveMime = commit.detectedMime ?? mimeType;

  const docRow = await withTenantContext(
    { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' },
    async (tx) => {
      const document = await tx.document.create({
        data: {
          tenantId,
          clientId,
          ownerStaffId: null,
          title,
          classification: 'GENERAL',
          mimeType: effectiveMime,
          retentionUntil: commit.retentionUntil,
          // Vom Mandanten selbst hochgeladen (Portal-Upload / Anforderungs-
          // Antwort) → automatisch geteilt, sonst sähe er seinen eigenen
          // Upload nicht mehr. sharedByStaff bleibt null (client-originiert).
          sharedWithClientAt: new Date(),
        },
      });
      await tx.documentVersion.create({
        data: {
          documentId: document.id,
          versionNo: 1,
          storageBucket: commit.targetBucket,
          storageKey: commit.targetKey,
          sha256: commit.sha256,
          sizeBytes: commit.sizeBytes,
          immutable: commit.immutable,
          scanStatus: 'CLEAN',
          scanCompletedAt: new Date(),
          createdById: contactId,
        },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'CLIENT_CONTACT',
        actorId: contactId,
        action: 'document.upload',
        resourceType: 'document',
        resourceId: document.id,
        after: {
          title,
          classification: 'GENERAL',
          clientId,
          sha256: commit.sha256.toString('hex'),
          source: 'portal',
        },
        ip: getClientIp(req.headers),
        userAgent: req.headers.get('user-agent'),
      });
      return document;
    },
  );

  emitN8nEvent('document.uploaded', {
    tenantId,
    documentId: docRow.id,
    classification: 'GENERAL',
    clientId,
    isGobd: false,
    source: 'portal',
  });

  return NextResponse.json({
    ok: true,
    documentId: docRow.id,
  });
}
