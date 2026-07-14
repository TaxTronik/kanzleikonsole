// =============================================================================
// GET /api/staff/documents/[id]/preview-url
//
// Liefert die Bytes für die Inline-Anzeige im Browser — app-proxied, NICHT
// presigned-direct (Variante B: der Object-Store ist nie ein eigener Browser-
// Origin). Zwei Modi:
//   - ?stream=1 → Bytes werden durch die App gestreamt (iframe/PDF-Viewer-src)
//   - sonst     → JSON-Metadata; `url` zeigt auf diese Route mit ?stream=1
// Im Gegensatz zu `/download` setzt der Stream Content-Disposition: inline
// (PDF-Viewer statt Download) — aber nur für MIME-Typen der Inline-Whitelist.
// =============================================================================

import { NextResponse, type NextRequest } from 'next/server';
import { getClientIp } from '@/server/rate-limit';
import { staffAuth } from '@/server/auth/staff';
import { canAccessClientTx } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { documentPreviewMetadata, loadDocumentPreview } from '@/server/storage/document-preview';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await staffAuth();
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const { tenantId, staffId } = session.user;

  const doc = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      // Audit 4: expliziter Tenant-Filter zusätzlich zu RLS — Defense in Depth.
      const d = await tx.document.findFirst({
        // deletedAt: null — soft-gelöschte Dokumente nicht mehr per URL anzeigbar.
        where: { id, tenantId, deletedAt: null },
        include: { versions: { orderBy: { versionNo: 'desc' }, take: 1 } },
      });
      if (!d || !d.versions[0]) return null;
      // Zugriffsmodell (vertraulich-Flag / RESTRICTED): wie /download —
      // Verweigerung → null → 404 (kein Existenz-Leak), VOR dem Audit-Eintrag.
      if (d.clientId && !(await canAccessClientTx(tx, session, d.clientId))) return null;
      // Audit-Nebeneffekt: darf die Vorschau nicht blockieren (ein Audit-Fehler
      // soll nicht verhindern, dass ein berechtigter Nutzer das Dokument sieht).
      try {
        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'document.preview',
          resourceType: 'document',
          resourceId: id,
          ip: getClientIp(req.headers),
          userAgent: req.headers.get('user-agent'),
        });
      } catch {
        // bewusst schlucken — Vorschau hat Vorrang vor dem Audit-Nebeneintrag.
      }
      const isPoaDocument = await tx.powerOfAttorney.findFirst({
        where: { tenantId, documentId: d.id },
        select: { id: true },
      });
      return {
        title: d.title,
        mimeType: d.mimeType,
        classification: d.classification,
        bucket: d.versions[0].storageBucket,
        key: d.versions[0].storageKey,
        isPoaDocument: !!isPoaDocument,
      };
    },
  );

  if (!doc) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // Zwei Modi (Object-Store bleibt intern, kein presigned-direct mehr):
  //  - ?stream=1 → Bytes inline durchstreamen (iframe/PDF-Viewer-src)
  //  - sonst     → JSON-Metadata; `url` zeigt auf diese Route mit ?stream=1
  // MIME-Whitelist verhindert, dass z. B. als text/html hochgeladene
  // Dateien inline gerendert werden (XSS).
  if (req.nextUrl.searchParams.get('stream') === '1') {
    let preview: Awaited<ReturnType<typeof loadDocumentPreview>>;
    try {
      preview = await loadDocumentPreview(doc);
    } catch {
      return NextResponse.json({ error: 'storage_unavailable' }, { status: 502 });
    }
    const headers: Record<string, string> = {
      ...preview.headers,
      // Audit 2026-06 Befund 4: CSP sandbox für text/plain — Inline-Anzeige
      // hängt nicht mehr allein an nosniff.
    };
    return new NextResponse(new Uint8Array(preview.bytes), { status: 200, headers });
  }

  const url = `${req.nextUrl.pathname}?stream=1`;
  const meta = documentPreviewMetadata(doc);
  return NextResponse.json({ url, mimeType: meta.mimeType, title: meta.title });
}
