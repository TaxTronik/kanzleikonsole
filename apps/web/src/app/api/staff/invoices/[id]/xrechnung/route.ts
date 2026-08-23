import { NextResponse, type NextRequest } from 'next/server';
import { getClientIp, checkStaffExportLimit } from '@/server/rate-limit';
import { staffAuth } from '@/server/auth/staff';
import { canAccessClientTx } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { commitBytesWithTier } from '@taxtronik/storage';
import { evidenceService } from '@/server/container';
import { prismaBytes } from '@/server/db/prisma-bytes';
import { generateXRechnungCii, toXRechnungInvoice } from '@/server/invoicing/xrechnung';
import { readSellerInfo } from '@/server/settings/tenant-settings';
import { isUuid } from '@/lib/uuid';
import { compensateStorageCommit } from '@/server/documents/storage-compensation';
import { isModeModuleEnabled, readModules } from '@/server/settings/modules';

interface ArchiveXmlInput {
  ctx: { tenantId: string; actorId: string; actorType: 'STAFF' };
  tenantId: string;
  staffId: string;
  clientId: string;
  title: string;
  xml: string;
  shareable: boolean;
}

async function ensureArchivedXmlCopy(input: ArchiveXmlInput): Promise<void> {
  const existing = await withTenantContext(input.ctx, (tx) =>
    tx.document.findFirst({
      where: {
        tenantId: input.tenantId,
        clientId: input.clientId,
        title: input.title,
        classification: 'GOBD_INVOICE',
        deletedAt: null,
      },
      include: { versions: { orderBy: { versionNo: 'desc' }, take: 1 } },
    }),
  );
  if (existing?.versions[0]) {
    if (input.shareable && !existing.sharedWithClientAt) {
      await withTenantContext(input.ctx, (tx) =>
        tx.document.updateMany({
          where: { id: existing.id, sharedWithClientAt: null },
          data: { sharedWithClientAt: new Date(), sharedByStaff: input.staffId },
        }),
      );
    }
    return;
  }

  let stored: Awaited<ReturnType<typeof commitBytesWithTier>> | null = null;
  try {
    stored = await commitBytesWithTier({
      fileData: Buffer.from(input.xml, 'utf8'),
      tier: 'GOBD',
      tenantId: input.tenantId,
      skipScan: true,
      classification: 'GOBD_INVOICE',
    });
    const committed = stored;
    await withTenantContext(input.ctx, async (tx) => {
      const doc = await tx.document.create({
        data: {
          tenantId: input.tenantId,
          clientId: input.clientId,
          title: input.title,
          classification: 'GOBD_INVOICE',
          mimeType: 'application/xml',
          retentionUntil: committed.retentionUntil,
          sharedWithClientAt: input.shareable ? new Date() : null,
          sharedByStaff: input.shareable ? input.staffId : null,
        },
      });
      await tx.documentVersion.create({
        data: {
          documentId: doc.id,
          versionNo: 1,
          storageBucket: committed.targetBucket,
          storageKey: committed.targetKey,
          storageVersionId: committed.storageVersionId,
          sha256: prismaBytes(committed.sha256),
          sizeBytes: committed.sizeBytes,
          immutable: committed.immutable,
          scanStatus: 'CLEAN',
          scanCompletedAt: new Date(),
          createdById: input.staffId,
        },
      });
    });
  } catch (error) {
    if (stored) {
      await compensateStorageCommit({
        tenantId: input.tenantId,
        source: 'staff.invoice.xrechnung',
        commit: stored,
        cause: error,
      });
    }
    // Der Download selbst bleibt nutzbar; ein späterer Abruf versucht die
    // revisionssichere Ablage erneut.
  }
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

  // Export-Limit wie die CSV-Routen: jeder GET rendert XML und kann einen
  // GoBD-Storage-Commit auslösen.
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

  const seller = await readSellerInfo(ctx);

  // Pflichtfeld-Check — E-Mail/Telefon sind XRechnung-Pflicht (BG-6, BR-DE-2/-6/-7);
  // USt-ID ODER Steuernummer ist bei Standardsatz-Positionen Pflicht
  // (EN-16931 BR-S-02 / BR-CO-26) — ohne sie lehnt KoSIT die Rechnung ab.
  if (
    !seller.name ||
    !seller.street ||
    !seller.city ||
    !seller.postalCode ||
    !seller.email ||
    !seller.phone ||
    (!seller.vatId && !seller.taxNumber)
  ) {
    return NextResponse.json(
      {
        error: 'seller_incomplete',
        message:
          'Verkäufer-Stammdaten unvollständig. Bitte zuerst unter /staff/admin/settings ergänzen (Name, Straße, PLZ, Ort, E-Mail, Telefon, USt-ID oder Steuernummer).',
      },
      { status: 422 },
    );
  }
  if (invoice.reverseCharge && !seller.vatId) {
    return NextResponse.json(
      {
        error: 'reverse_charge_seller_no_vatid',
        message:
          'Reverse-Charge (§ 13b UStG) erfordert die USt-IdNr der Kanzlei. Bitte zuerst unter /staff/admin/settings ergänzen.',
      },
      { status: 422 },
    );
  }
  if (!invoice.client.street || !invoice.client.city || !invoice.client.postalCode) {
    return NextResponse.json(
      {
        error: 'buyer_incomplete',
        message:
          'Mandanten-Adresse unvollständig. Bitte zuerst Adresse beim Mandanten ergänzen (Straße, PLZ, Ort).',
      },
      { status: 422 },
    );
  }

  const xml = generateXRechnungCii(toXRechnungInvoice(invoice), seller, {
    name: invoice.client.name,
    street: invoice.client.street,
    postalCode: invoice.client.postalCode,
    city: invoice.client.city,
    countryIso: invoice.client.countryIso ?? 'DE',
    vatId: invoice.client.vatId,
    email: invoice.client.invoiceEmail,
  });

  const shareable =
    invoice.status === 'SENT' || invoice.status === 'PAID' || invoice.status === 'OVERDUE';
  const xmlTitle = `Rechnung ${invoice.number} (XRechnung)`;
  await ensureArchivedXmlCopy({
    ctx,
    tenantId,
    staffId,
    clientId: invoice.clientId,
    title: xmlTitle,
    xml,
    shareable,
  });

  // Audit-Log (separate Tx, da Hauptlogik abgeschlossen)
  await withTenantContext(ctx, async (tx) => {
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'invoice.xrechnung.download',
      resourceType: 'invoice',
      resourceId: id,
      after: { number: invoice.number, format: 'XRechnung 3.0' },
      ip: getClientIp(req.headers),
      userAgent: req.headers.get('user-agent'),
    });
  });

  const fileName = `xrechnung-${invoice.number.replace(/[^A-Za-z0-9_-]/g, '_')}.xml`;
  return new NextResponse(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Cache-Control': 'no-store',
    },
  });
}
