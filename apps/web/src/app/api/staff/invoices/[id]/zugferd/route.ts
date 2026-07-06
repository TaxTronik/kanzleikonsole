import { NextResponse, type NextRequest } from 'next/server';
import { getClientIp, checkStaffExportLimit } from '@/server/rate-limit';
import { staffAuth } from '@/server/auth/staff';
import { canAccessClientTx } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { streamObject } from '@taxtronik/storage';
import { ensureZugferdArchive } from '@/server/invoicing/archive';
import { withTimeout, TimeoutError } from '@/lib/with-timeout';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await staffAuth();
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };

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
  if (!accessible) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // Option B: byte-stabile ZUGFeRD-Archiv-PDF sicherstellen (einmal generiert +
  // revisionssicher abgelegt). Wurde sie beim Ausstellen (markSent) erzeugt,
  // ist das hier nur ein Lookup; sonst wird sie jetzt generiert + gespeichert.
  // Validierung (Adresse vollständig) liegt im Helfer.
  // Zeitdach: PDF-Gen + Object-Store sind gebunden, damit der Download nie
  // endlos am Browser-Spinner hängen bleibt (früher „lädt ewig").
  let archive;
  try {
    archive = await withTimeout(ensureZugferdArchive(ctx, id), 45_000);
  } catch (err) {
    if (err instanceof TimeoutError) {
      return NextResponse.json(
        { error: 'timeout', message: 'Zeitüberschreitung beim Erzeugen der ZUGFeRD-PDF — bitte erneut versuchen.' },
        { status: 504 },
      );
    }
    // Echten Fehlertext durchreichen (enthält Schritt-Kontext aus
    // ensureZugferdArchive: PDF-Generierung vs. GOBD-Ablage) — sonst raten
    // wir bei „ZUGFeRD geht nicht" nur über die Ursache.
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: 'generation_failed', message: detail },
      { status: 502 },
    );
  }
  if (!archive.ok) {
    if (archive.code === 'seller_incomplete') {
      return NextResponse.json(
        { error: 'seller_incomplete', message: 'Verkäufer-Stammdaten unvollständig (Name, Straße, PLZ, Ort, E-Mail, Telefon).' },
        { status: 422 },
      );
    }
    if (archive.code === 'buyer_incomplete') {
      return NextResponse.json(
        { error: 'buyer_incomplete', message: 'Mandanten-Adresse unvollständig (Straße, PLZ, Ort).' },
        { status: 422 },
      );
    }
    // not_found | not_applicable (z. B. EXTERNAL/PDF-Rechnung)
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

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

  // App-proxied: die archivierten Bytes direkt durchstreamen (O(1)).
  const fileName = `zugferd-${archive.number.replace(/[^A-Za-z0-9_-]/g, '_')}.pdf`;
  const obj = await streamObject(archive.bucket, archive.key);
  const headers: Record<string, string> = {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${fileName}"`,
    'Cache-Control': 'private, no-store',
  };
  if (obj.contentLength !== null) headers['Content-Length'] = String(obj.contentLength);
  return new NextResponse(obj.body, { status: 200, headers });
}
