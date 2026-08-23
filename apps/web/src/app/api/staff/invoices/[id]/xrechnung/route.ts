import { NextResponse, type NextRequest } from 'next/server';
import { getClientIp, checkStaffExportLimit } from '@/server/rate-limit';
import { staffAuth } from '@/server/auth/staff';
import { canAccessClientTx } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { streamObject } from '@taxtronik/storage';
import { evidenceService } from '@/server/container';
import {
  generateXRechnungCii,
  toXRechnungInvoice,
  type StoredInvoiceForXRechnung,
} from '@/server/invoicing/xrechnung';
import { lockInvoiceArchiveTx } from '@/server/invoicing/archive-lock';
import { ensureZugferdArchive } from '@/server/invoicing/archive';
import { readSellerInfo, type SellerInfo } from '@/server/settings/tenant-settings';
import { isUuid } from '@/lib/uuid';
import { isModeModuleEnabled, readModules } from '@/server/settings/modules';

interface ArchiveXmlInput {
  ctx: { tenantId: string; actorId: string; actorType: 'STAFF' };
  tenantId: string;
  staffId: string;
  invoiceId: string;
}

type ArchiveXmlState =
  | { state: 'ready'; bucket: string; key: string }
  | { state: 'missing' | 'not_found' | 'status_conflict' };

function invoiceStatusAllowsPortalShare(status: string, sentAt: Date | null): boolean {
  return sentAt !== null || status === 'SENT' || status === 'PAID' || status === 'OVERDUE';
}

interface XmlInvoice extends StoredInvoiceForXRechnung {
  client: {
    name: string;
    street: string | null;
    city: string | null;
    postalCode: string | null;
    countryIso: string | null;
    vatId: string | null;
    invoiceEmail: string | null;
  };
}

function xmlInputError(
  invoice: XmlInvoice,
  seller: SellerInfo,
): { error: string; message: string } | null {
  if (
    !seller.name ||
    !seller.street ||
    !seller.city ||
    !seller.postalCode ||
    !seller.email ||
    !seller.phone ||
    (!seller.vatId && !seller.taxNumber)
  ) {
    return {
      error: 'seller_incomplete',
      message:
        'Verkäufer-Stammdaten unvollständig. Bitte zuerst unter /staff/admin/settings ergänzen (Name, Straße, PLZ, Ort, E-Mail, Telefon, USt-ID oder Steuernummer).',
    };
  }
  if (invoice.reverseCharge && !seller.vatId) {
    return {
      error: 'reverse_charge_seller_no_vatid',
      message:
        'Reverse-Charge (§ 13b UStG) erfordert die USt-IdNr der Kanzlei. Bitte zuerst unter /staff/admin/settings ergänzen.',
    };
  }
  if (!invoice.client.street || !invoice.client.city || !invoice.client.postalCode) {
    return {
      error: 'buyer_incomplete',
      message:
        'Mandanten-Adresse unvollständig. Bitte zuerst Adresse beim Mandanten ergänzen (Straße, PLZ, Ort).',
    };
  }
  return null;
}

function renderXml(invoice: XmlInvoice, seller: SellerInfo): string {
  return generateXRechnungCii(toXRechnungInvoice(invoice), seller, {
    name: invoice.client.name,
    street: invoice.client.street!,
    postalCode: invoice.client.postalCode!,
    city: invoice.client.city!,
    countryIso: invoice.client.countryIso ?? 'DE',
    vatId: invoice.client.vatId,
    email: invoice.client.invoiceEmail,
  });
}

/**
 * Liest die bestehende Archivfassung unter demselben Rechnungs-Lock wie
 * Versand und Storno. Ein bereits storniertes, nie versendetes DRAFT kann so
 * weder erneut freigegeben noch nachträglich archiviert werden.
 */
async function readArchivedXmlCopy(input: ArchiveXmlInput): Promise<ArchiveXmlState> {
  return withTenantContext(input.ctx, async (tx) => {
    await lockInvoiceArchiveTx(tx, input.invoiceId);
    const fresh = await tx.invoice.findFirst({
      where: { id: input.invoiceId, tenantId: input.tenantId },
      select: {
        status: true,
        sentAt: true,
        xrechnungDocument: {
          select: {
            id: true,
            sharedWithClientAt: true,
            versions: { orderBy: { versionNo: 'desc' }, take: 1 },
          },
        },
      },
    });
    if (!fresh) return { state: 'not_found' as const };
    if (fresh.status === 'CANCELLED' && !fresh.sentAt) {
      return { state: 'status_conflict' as const };
    }
    const existing = fresh.xrechnungDocument;
    const version = existing?.versions[0];
    if (!existing || !version) return { state: 'missing' as const };
    if (
      invoiceStatusAllowsPortalShare(fresh.status, fresh.sentAt) &&
      !existing.sharedWithClientAt
    ) {
      await tx.document.updateMany({
        where: { id: existing.id, sharedWithClientAt: null },
        data: { sharedWithClientAt: new Date(), sharedByStaff: input.staffId },
      });
    }
    return {
      state: 'ready' as const,
      bucket: version.storageBucket,
      key: version.storageKey,
    };
  });
}

async function recheckDraftXmlPreview(input: {
  ctx: ArchiveXmlInput['ctx'];
  tenantId: string;
  invoiceId: string;
  updatedAt: Date;
  documentId: string | null;
  xrechnungDocumentId: string | null;
}): Promise<'current' | 'issued' | 'not_found' | 'status_conflict'> {
  return withTenantContext(input.ctx, async (tx) => {
    await lockInvoiceArchiveTx(tx, input.invoiceId);
    const fresh = await tx.invoice.findFirst({
      where: { id: input.invoiceId, tenantId: input.tenantId },
      select: {
        status: true,
        sentAt: true,
        updatedAt: true,
        documentId: true,
        xrechnungDocumentId: true,
      },
    });
    if (!fresh) return 'not_found';
    if (fresh.status === 'CANCELLED' && !fresh.sentAt) return 'status_conflict';
    const archivePointerChanged =
      fresh.documentId !== input.documentId ||
      fresh.xrechnungDocumentId !== input.xrechnungDocumentId;
    if (fresh.status !== 'DRAFT' || archivePointerChanged) return 'issued';
    return fresh.updatedAt.getTime() === input.updatedAt.getTime() ? 'current' : 'status_conflict';
  });
}

type ReadyXmlArchive = Extract<ArchiveXmlState, { state: 'ready' }>;

function archiveStateResponse(state: 'not_found' | 'status_conflict'): NextResponse {
  if (state === 'not_found') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json(
    {
      error: 'status_conflict',
      message: 'Die Rechnung wurde während der XRechnung-Erzeugung geändert oder storniert.',
    },
    { status: 409 },
  );
}

async function resolveIssuedXmlArchive(
  input: ArchiveXmlInput,
): Promise<
  { archive: ReadyXmlArchive; response?: never } | { archive?: never; response: NextResponse }
> {
  let archive = await readArchivedXmlCopy(input);
  if (archive.state === 'ready') return { archive };
  if (archive.state !== 'missing') return { response: archiveStateResponse(archive.state) };

  let ensured: Awaited<ReturnType<typeof ensureZugferdArchive>>;
  try {
    // Kanonischer Archivpfad erzeugt PDF + XML aus demselben Snapshot bzw.
    // extrahiert bei Legacy-Beständen exakt die eingebettete factur-x.xml der
    // vorhandenen Hybrid-PDF.
    ensured = await ensureZugferdArchive(input.ctx, input.invoiceId, { purpose: 'ISSUE' });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      response: NextResponse.json({ error: 'archive_failed', message: detail }, { status: 502 }),
    };
  }
  if (!ensured.ok) {
    if (ensured.code === 'status_conflict' || ensured.code === 'not_found') {
      return { response: archiveStateResponse(ensured.code) };
    }
    if (ensured.code === 'not_applicable') {
      return { response: NextResponse.json({ error: 'not_found' }, { status: 404 }) };
    }
    return {
      response: NextResponse.json(
        { error: ensured.code, message: 'Rechnungs-Stammdaten sind unvollständig.' },
        { status: 422 },
      ),
    };
  }

  archive = await readArchivedXmlCopy(input);
  if (archive.state === 'ready') return { archive };
  return {
    response: NextResponse.json(
      { error: 'archive_failed', message: 'XRechnung wurde nicht im Archiv verknüpft.' },
      { status: 502 },
    ),
  };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await staffAuth();
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  if (!isModeModuleEnabled(await readModules(ctx), 'invoices')) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // Export-Limit wie die CSV-Routen: DRAFT rendert eine Vorschau; bei
  // ausgestelltem Altbestand kann der kanonische Archivpfad fehlende
  // PDF/XML-Kopien revisionssicher nachziehen.
  const rl = await checkStaffExportLimit('xrechnung', staffId);
  if (!rl.ok) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  // Audit Round 15, Finding 4: expliziter tenantId-Filter zusätzlich zu RLS.
  // XRechnung-XML enthält Verkäufer + Mandanten-Stammdaten (USt-ID,
  // Adresse) — RLS-Drift wäre direkter Cross-Tenant-Read.
  const invoice = await withTenantContext(ctx, async (tx) => {
    const inv = await tx.invoice.findFirst({
      where: { id, tenantId },
      include: {
        client: true,
        positions: { orderBy: { position: 'asc' } },
        stornoOf: { select: { number: true } },
      },
    });
    if (!inv) return null;
    // Zugriffsmodell (vertraulich-Flag / RESTRICTED): Rechnung gehört zu einem
    // gesperrten Mandanten → null → 404 (kein Existenz-Leak).
    if (!(await canAccessClientTx(tx, session, inv.clientId))) return null;
    return inv;
  });

  if (!invoice) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  let draftXml: string | null = null;
  let archive: ArchiveXmlState | null = null;
  let useArchive = invoice.status !== 'DRAFT';

  if (invoice.status === 'DRAFT') {
    // Ein Entwurf ist noch kein festgeschriebener Beleg. Der Kontroll-Download
    // wird deshalb frisch erzeugt, aber nicht irreversibel im GOBD-Bucket
    // archiviert. Beim Versand erzeugt ensureZugferdArchive PDF und XML aus
    // demselben Snapshot; so kann kein früher Stammdatenstand wiederverwendet
    // werden und Factur-X/XML driften nicht auseinander.
    const seller = await readSellerInfo(ctx);
    const invalid = xmlInputError(invoice, seller);
    if (invalid) return NextResponse.json(invalid, { status: 422 });
    const rendered = renderXml(invoice, seller);
    const rechecked = await recheckDraftXmlPreview({
      ctx,
      tenantId,
      invoiceId: id,
      updatedAt: invoice.updatedAt,
      documentId: invoice.documentId,
      xrechnungDocumentId: invoice.xrechnungDocumentId,
    });
    if (rechecked === 'not_found' || rechecked === 'status_conflict') {
      return archiveStateResponse(rechecked);
    }
    if (rechecked === 'current') draftXml = rendered;
    else useArchive = true;
  }
  if (useArchive) {
    const resolved = await resolveIssuedXmlArchive({
      ctx,
      tenantId,
      staffId,
      invoiceId: id,
    });
    if (resolved.response) return resolved.response;
    archive = resolved.archive;
  }

  // Audit-Log (separate Tx, da Hauptlogik abgeschlossen)
  await withTenantContext(ctx, async (tx) => {
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'invoice.xrechnung.download',
      resourceType: 'invoice',
      resourceId: id,
      after: { number: invoice.number, format: 'XRechnung 3.0', draftPreview: draftXml !== null },
      ip: getClientIp(req.headers),
      userAgent: req.headers.get('user-agent'),
    });
  });

  const fileName = `xrechnung-${invoice.number.replace(/[^A-Za-z0-9_-]/g, '_')}.xml`;
  if (draftXml !== null) {
    return new NextResponse(draftXml, {
      status: 200,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  }
  if (!archive || archive.state !== 'ready') {
    return NextResponse.json({ error: 'archive_failed' }, { status: 502 });
  }
  const object = await streamObject(archive.bucket, archive.key);
  const responseHeaders: Record<string, string> = {
    'Content-Type': 'application/xml; charset=utf-8',
    'Content-Disposition': `attachment; filename="${fileName}"`,
    'Cache-Control': 'private, no-store',
  };
  if (object.contentLength !== null) {
    responseHeaders['Content-Length'] = String(object.contentLength);
  }
  return new NextResponse(object.body, { status: 200, headers: responseHeaders });
}
