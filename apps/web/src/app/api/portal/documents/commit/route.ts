// App-proxied Upload (kein presigned-direct): Browser POSTet multipart,
// die App streamt intern zu SeaweedFS. Object-Store nie öffentlich.
import { NextResponse, type NextRequest } from 'next/server';
import { portalBaseUrl } from '@taxtronik/config';
import { getClientIp, checkPortalWriteLimit } from '@/server/rate-limit';
import { z } from 'zod';
import { portalAuth } from '@/server/auth/portal';
import { assertSameOrigin } from '@/server/http/assert-same-origin';
import { commitDocumentFromBytes, MAX_UPLOAD_BYTES } from '@taxtronik/storage';
import { withTenantContext } from '@taxtronik/db';
import {
  parseMultipartUpload,
  storageCommitErrorResponse,
  createDocumentWithVersion,
} from '@/server/documents/upload-helpers';
import { evidenceService } from '@/server/container';
import { emitN8nEvent } from '@/server/n8n/emit';

const Schema = z.object({
  title: z.string().min(1).max(500),
  mimeType: z.string().min(1).max(255).default('application/octet-stream'),
});

export async function POST(req: NextRequest) {
  // CSRF-Defense-in-Depth (zusätzlich zu SameSite=lax): Cross-Origin-POSTs
  // ablehnen, bevor irgendetwas gepuffert oder authentifiziert wird.
  // Portal-Surface → Mandanten-Domain (portalBaseUrl, Fallback NEXTAUTH_URL).
  const csrf = assertSameOrigin(req, portalBaseUrl);
  if (csrf) return csrf;

  const session = await portalAuth();
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Befund 13: Rate-Limit analog zu den Portal-Write-Actions (S4-Backstop) —
  // Uploads sättigen sonst Storage + ClamAV ohne jede Begrenzung.
  const rl = await checkPortalWriteLimit(session.user.contactId);
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'rate_limited', retryAfter: rl.retryAfter },
      { status: 429 },
    );
  }

  // Befund 13 (analog Staff-Route): ehrlich deklarierte Über-Größe ablehnen,
  // BEVOR req.formData() den gesamten Body in den RAM puffert (+1 MB Marge
  // für Multipart-Framing + Metadatenfelder). Lügt der Client über
  // Content-Length, greift der file.size-Check im Multipart-Helfer.
  const declaredLen = Number(req.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLen) && declaredLen > MAX_UPLOAD_BYTES + 1024 * 1024) {
    return NextResponse.json({ error: 'TOO_LARGE' }, { status: 413 });
  }

  // Befund 12: Multipart-Parse + Datei-Checks zentral (upload-helpers).
  const upload = await parseMultipartUpload(req);
  if (!upload.ok) return upload.response;
  const { form, file } = upload;

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
    // Befund 12: Mapping zentral (war 3× wortgleich kopiert).
    return storageCommitErrorResponse(e);
  }

  // M-2: Magic-Bytes-Detection schlägt Client-gemeldete mimeType, wenn ein
  // bekanntes Format erkannt wurde. Ein User, der text/html als image/jpeg
  // deklariert, bekommt jetzt die echte MIME gespeichert; Preview-Route
  // serviert dann mit dem echten Type (preview-mime-Whitelist greift trotzdem).
  const effectiveMime = commit.detectedMime ?? mimeType;

  const docRow = await withTenantContext(
    { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' },
    async (tx) => {
      // Befund 12: Document+Version-Insert zentral (upload-helpers).
      const { document } = await createDocumentWithVersion(tx, {
        documentData: {
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
        commit,
        createdById: contactId,
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
