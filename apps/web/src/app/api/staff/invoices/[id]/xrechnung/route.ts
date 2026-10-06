import { NextResponse, type NextRequest } from 'next/server';
import { getClientIp, checkStaffExportLimit } from '@/server/rate-limit';
import { staffAuth } from '@/server/auth/staff';
import { canAccessClientTx } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { streamObject } from '@taxtronik/storage';
import { evidenceService } from '@/server/container';
import { generateXRechnungCii, toXRechnungInvoice } from '@/server/invoicing/xrechnung';
import { lockInvoiceArchiveTx } from '@/server/invoicing/archive-lock';
import {
  archiveInputFailure,
  ensureZugferdArchive,
  hasGeneratedEInvoice,
  isCancelledDraft,
  isInvoiceShareable,
  recheckDraftPreview,
  xrechnungBuyer,
  type ArchiveFailureCode,
  type ArtifactInvoice,
  type DraftPreviewSnapshot,
} from '@/server/invoicing/archive';
import {
  archiveFailureResponse,
  type ArchiveRouteFailureCode,
} from '@/server/invoicing/archive-failure';
import { readSellerInfo } from '@/server/settings/tenant-settings';
import { isUuid } from '@/lib/uuid';
import { isModeModuleEnabled, readModules } from '@/server/settings/modules';

interface ArchiveXmlInput {
  ctx: { tenantId: string; actorId: string; actorType: 'STAFF' };
  tenantId: string;
  staffId: string;
  invoiceId: string;
}

type ArchiveXmlState =
  | { state: 'ready'; bucket: string; key: string; storageVersionId: string | null }
  | { state: 'missing' | 'not_found' | 'status_conflict' };

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
    if (isCancelledDraft(fresh)) return { state: 'status_conflict' as const };
    const existing = fresh.xrechnungDocument;
    const version = existing?.versions[0];
    if (!existing || !version) return { state: 'missing' as const };
    if (isInvoiceShareable(fresh) && !existing.sharedWithClientAt) {
      await tx.document.updateMany({
        where: { id: existing.id, sharedWithClientAt: null },
        data: { sharedWithClientAt: new Date(), sharedByStaff: input.staffId },
      });
    }
    return {
      state: 'ready' as const,
      bucket: version.storageBucket,
      key: version.storageKey,
      storageVersionId: version.storageVersionId,
    };
  });
}

type DraftXmlPreview =
  | { state: 'preview'; xml: string }
  | { state: 'issued' }
  | { state: 'failed'; code: ArchiveFailureCode };

/**
 * Ein Entwurf ist noch kein festgeschriebener Beleg. Der Kontroll-Download
 * wird deshalb frisch erzeugt, aber nicht irreversibel im GOBD-Bucket
 * archiviert. Beim Versand erzeugt ensureZugferdArchive PDF und XML aus
 * demselben Snapshot; so kann kein früher Stammdatenstand wiederverwendet
 * werden und Factur-X/XML driften nicht auseinander. Prüfungen, Käufer-Mapping
 * und Recheck sind dieselben wie in der ZUGFeRD-Vorschau (archive.ts).
 */
async function renderDraftXmlPreview(
  ctx: ArchiveXmlInput['ctx'],
  invoice: ArtifactInvoice & DraftPreviewSnapshot & { id: string; format: string },
): Promise<DraftXmlPreview> {
  if (!hasGeneratedEInvoice(invoice)) return { state: 'failed', code: 'not_applicable' };
  const seller = await readSellerInfo(ctx);
  const invalid = archiveInputFailure(invoice, seller);
  if (invalid) return { state: 'failed', code: invalid };
  const xml = generateXRechnungCii(
    toXRechnungInvoice(invoice),
    seller,
    xrechnungBuyer(invoice.client),
  );
  const rechecked = await recheckDraftPreview(ctx, invoice.id, invoice);
  if (rechecked.state === 'preview') return { state: 'preview', xml };
  if (rechecked.state === 'issued') return { state: 'issued' };
  return { state: 'failed', code: rechecked.state };
}

type ReadyXmlArchive = Extract<ArchiveXmlState, { state: 'ready' }>;

type IssuedXmlArchive =
  | { archive: ReadyXmlArchive; failure?: never }
  | { archive?: never; failure: ArchiveRouteFailureCode; error?: unknown };

async function resolveIssuedXmlArchive(input: ArchiveXmlInput): Promise<IssuedXmlArchive> {
  let archive = await readArchivedXmlCopy(input);
  if (archive.state === 'ready') return { archive };
  if (archive.state !== 'missing') return { failure: archive.state };

  let ensured: Awaited<ReturnType<typeof ensureZugferdArchive>>;
  try {
    // Kanonischer Archivpfad erzeugt PDF + XML aus demselben Snapshot bzw.
    // extrahiert bei Legacy-Beständen exakt die eingebettete factur-x.xml der
    // vorhandenen Hybrid-PDF.
    ensured = await ensureZugferdArchive(input.ctx, input.invoiceId, { purpose: 'ISSUE' });
  } catch (error) {
    return { failure: 'generation_failed', error };
  }
  if (!ensured.ok) return { failure: ensured.code };

  archive = await readArchivedXmlCopy(input);
  if (archive.state === 'ready') return { archive };
  return { failure: archive.state === 'missing' ? 'archive_failed' : archive.state };
}

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

  if (!invoice) return archiveFailureResponse('not_found');

  // Technische Fehlerursachen nur ins Server-Log, nie in den Response-Body.
  const detail = { route: 'xrechnung' as const, tenantId, invoiceId: id };
  let draftXml: string | null = null;
  if (invoice.status === 'DRAFT') {
    let preview: DraftXmlPreview;
    try {
      preview = await renderDraftXmlPreview(ctx, invoice);
    } catch (error) {
      return archiveFailureResponse('generation_failed', { ...detail, error });
    }
    if (preview.state === 'failed') return archiveFailureResponse(preview.code);
    // `issued`: Die Ausstellung hat das Rendern überholt → kanonisches Archiv.
    if (preview.state === 'preview') draftXml = preview.xml;
  }

  let archive: ReadyXmlArchive | null = null;
  if (draftXml === null) {
    const resolved = await resolveIssuedXmlArchive({
      ctx,
      tenantId,
      staffId,
      invoiceId: id,
    });
    if (resolved.failure) {
      return archiveFailureResponse(resolved.failure, { ...detail, error: resolved.error });
    }
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
  if (!archive) return archiveFailureResponse('archive_failed', detail);
  const object = await streamObject(archive.bucket, archive.key, archive.storageVersionId);
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
