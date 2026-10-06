// App-proxied Upload (kein presigned-direct): Browser POSTet multipart,
// die App streamt intern zu SeaweedFS. Object-Store nie öffentlich.
//
// Journal-first (K-06 / DOC-UPLOAD-JOURNAL-001): Feature-Freigabe vor Scan,
// Journal und Object-Write und erneut in der Commit-Transaktion; die
// Speicherabsicht steht vor dem PUT im Journal und wird mit dem
// Dokument-Insert atomar abgeschlossen (auch im Portal-Kontext, der das
// Journal per RLS nicht sieht).
import { NextResponse, type NextRequest } from 'next/server';
import { portalBaseUrl } from '@taxtronik/config';
import { getClientIp, checkPortalWriteLimit } from '@/server/rate-limit';
import { z } from 'zod';
import type { TxClient } from '@taxtronik/db';
import { portalAuth } from '@/server/auth/portal';
import { assertSameOrigin } from '@/server/http/assert-same-origin';
import {
  parseMultipartUpload,
  storageCommitErrorResponse,
  createDocumentWithVersion,
} from '@/server/documents/upload-helpers';
import { JournaledUploadError, runJournaledUpload } from '@/server/documents/journaled-upload';
import { evidenceService } from '@/server/container';
import { emitN8nEvent } from '@/server/n8n/emit';
import { readPortalFeaturesTx } from '@/server/settings/portal-features';
import { log } from '@/server/logger';

const Schema = z.object({
  title: z.string().min(1).max(500),
  mimeType: z.string().min(1).max(255).default('application/octet-stream'),
});

class PortalUploadDisabledError extends Error {}

/** Gemeinsame Vor- und Nachprüfung (K-06): F2-Feature-Flag für Portal-Uploads. */
async function checkPortalUploadTx(tx: TxClient, tenantId: string): Promise<void> {
  const features = await readPortalFeaturesTx(tx, tenantId);
  if (!features.documentUpload) throw new PortalUploadDisabledError();
}

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
    return NextResponse.json({ error: 'rate_limited', retryAfter: rl.retryAfter }, { status: 429 });
  }

  // Multipart-Body wird zentral am echten Stream begrenzt; das greift auch
  // ohne Content-Length und bei chunked Transfer-Encoding.
  const upload = await parseMultipartUpload(req);
  if (!upload.ok) return upload.response;
  const { form, file } = upload;

  const parsed = Schema.safeParse({
    title: form.get('title'),
    mimeType: form.get('mimeType') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'validation', issues: parsed.error.issues }, { status: 400 });
  }

  const { tenantId, contactId, clientId } = session.user;
  const { title, mimeType } = parsed.data;

  let stored;
  try {
    stored = await runJournaledUpload({
      context: { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' },
      source: 'portal.document.commit',
      // F2: Feature-Flag-Guard für Portal-Document-Upload.
      check: (tx) => checkPortalUploadTx(tx, tenantId),
      readBytes: async () => Buffer.from(await file.arrayBuffer()),
      storage: () => ({ tier: 'NONE', classification: 'GENERAL' }),
      commitTx: async (tx, { commit }) => {
        // M-2: Magic-Bytes-Detection schlägt Client-gemeldete mimeType, wenn
        // ein bekanntes Format erkannt wurde. Ein User, der text/html als
        // image/jpeg deklariert, bekommt jetzt die echte MIME gespeichert;
        // Preview-Route serviert dann mit dem echten Type (preview-mime-
        // Whitelist greift trotzdem).
        const effectiveMime = commit.detectedMime ?? mimeType;
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
        return { id: document.id };
      },
    });
  } catch (error) {
    return uploadErrorResponse(error, tenantId);
  }

  await emitN8nEvent(
    'document.uploaded',
    {
      tenantId,
      documentId: stored.result.id,
      classification: 'GENERAL',
      clientId,
      isGobd: false,
      source: 'portal',
    },
    { tenantId },
  );

  return NextResponse.json({
    ok: true,
    documentId: stored.result.id,
  });
}

function uploadErrorResponse(error: unknown, tenantId: string): NextResponse {
  const phase = error instanceof JournaledUploadError ? error.phase : null;
  const cause = error instanceof JournaledUploadError ? error.cause : error;
  // Kein Roh-Message-Leak: ein deaktiviertes Feature (oder ein Fehler beim
  // Lesen der Freigabe) liefert eine generische, stabile Antwort.
  if (phase === 'check' || cause instanceof PortalUploadDisabledError) {
    return NextResponse.json({ error: 'feature_disabled' }, { status: 403 });
  }
  if (phase === 'prepare' || phase === 'store') {
    // Befund 12: Mapping zentral (war 3× wortgleich kopiert).
    return storageCommitErrorResponse(cause);
  }
  // Nach dem Object-Write bleibt die Speicherabsicht offen; der Cleanup-Worker
  // räumt das Objekt nach der Sicherheitsfrist versionsgenau auf.
  log.error(
    {
      component: 'portal-documents-commit',
      tenantId,
      phase,
      err: (cause as Error)?.message ?? null,
    },
    'portal-documents-commit: Upload fehlgeschlagen',
  );
  return NextResponse.json({ error: 'database_commit_failed' }, { status: 500 });
}
