import { NextResponse, type NextRequest } from 'next/server';
import { getClientIp, checkStaffExportLimit } from '@/server/rate-limit';
import { staffAuth } from '@/server/auth/staff';
import { canAccessClientTx } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { streamObject } from '@taxtronik/storage';
import { ensureZugferdArchive, type ArchiveResult } from '@/server/invoicing/archive';
import { archiveFailureResponse } from '@/server/invoicing/archive-failure';
import { withTimeout, TimeoutError } from '@/lib/with-timeout';
import { isUuid } from '@/lib/uuid';
import { isModeModuleEnabled, readModules } from '@/server/settings/modules';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await staffAuth();
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  if (!isUuid(id)) return archiveFailureResponse('not_found');
  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  if (!isModeModuleEnabled(await readModules(ctx), 'invoices')) {
    return archiveFailureResponse('not_found');
  }

  const rl = await checkStaffExportLimit('zugferd', staffId);
  if (!rl.ok) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  // Zugriffsmodell (vertraulich-Flag / RESTRICTED): VOR ensureZugferdArchive
  // prüfen (das würde sonst ggf. generieren + ablegen). Gesperrter Mandant
  // oder unbekannte Rechnung → 404 (kein Existenz-Leak).
  const accessible = await withTenantContext(ctx, async (tx) => {
    const inv = await tx.invoice.findFirst({
      where: { id, tenantId },
      select: { clientId: true },
    });
    if (!inv) return false;
    return canAccessClientTx(tx, session, inv.clientId);
  });
  if (!accessible) return archiveFailureResponse('not_found');

  // Option B: byte-stabile ZUGFeRD-Archiv-PDF sicherstellen (einmal generiert +
  // revisionssicher abgelegt). Wurde sie beim Ausstellen (markSent) erzeugt,
  // ist das hier nur ein Lookup. Ein DRAFT wird frisch als nicht archivierte
  // Kontrollfassung gerendert; die Festschreibung erfolgt erst beim Versand.
  // Validierung (Stammdaten, Reverse-Charge, Adresse) liegt im Helfer; jeder
  // Ablehnungscode wird mit seinem Grund beantwortet (archiveFailureResponse).
  // Zeitdach: PDF-Gen + Object-Store sind gebunden, damit der Download nie
  // endlos am Browser-Spinner hängen bleibt (früher „lädt ewig").
  let archive: ArchiveResult;
  try {
    archive = await withTimeout(ensureZugferdArchive(ctx, id, { purpose: 'PREVIEW' }), 45_000);
  } catch (error) {
    // Der Fehlertext (Schritt-Kontext aus ensureZugferdArchive: PDF-Generierung
    // vs. GOBD-Ablage) geht nur ins Server-Log, nicht an den Client.
    return archiveFailureResponse(error instanceof TimeoutError ? 'timeout' : 'generation_failed', {
      route: 'zugferd',
      tenantId,
      invoiceId: id,
      error,
    });
  }
  if (!archive.ok) return archiveFailureResponse(archive.code);

  // Download auditieren (separate Tx, nach Sicherstellung des Archivs).
  await withTenantContext(ctx, async (tx) => {
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'invoice.zugferd.download',
      resourceType: 'invoice',
      resourceId: id,
      after: { number: archive.number, format: 'ZUGFeRD/Factur-X EN16931' },
      ip: getClientIp(req.headers),
      userAgent: req.headers.get('user-agent'),
    });
  });

  // Ausgestellte Rechnungen: archivierte Bytes direkt durchstreamen (O(1)).
  // DRAFT: frisch gerenderte Kontrollfassung; sie wird erst beim Versand
  // gemeinsam mit der separaten XML revisionssicher festgeschrieben.
  const fileName = `zugferd-${archive.number.replace(/[^A-Za-z0-9_-]/g, '_')}.pdf`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${fileName}"`,
    'Cache-Control': 'private, no-store',
  };
  if ('bytes' in archive) {
    headers['Content-Length'] = String(archive.bytes.length);
    return new NextResponse(new Uint8Array(archive.bytes), { status: 200, headers });
  }
  const obj = await streamObject(archive.bucket, archive.key, archive.storageVersionId);
  if (obj.contentLength !== null) headers['Content-Length'] = String(obj.contentLength);
  return new NextResponse(obj.body, { status: 200, headers });
}
