import { NextResponse, type NextRequest } from 'next/server';
import { getClientIp } from '@/server/rate-limit';
import { staffAuth } from '@/server/auth/staff';
import { canAccessClientTx } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { generateXRechnungCii } from '@/server/invoicing/xrechnung';
import { readSellerInfo } from '@/server/settings/tenant-settings';

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

  // Audit Round 15, Finding 4: expliziter tenantId-Filter zusätzlich zu RLS.
  // XRechnung-XML enthält Verkäufer + Mandanten-Stammdaten (USt-ID,
  // Adresse) — RLS-Drift wäre direkter Cross-Tenant-Read.
  const invoice = await withTenantContext(ctx, async (tx) => {
    const inv = await tx.invoice.findFirst({
      where: { id, tenantId },
      include: {
        client: true,
        positions: { orderBy: { position: 'asc' } },
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

  // Pflichtfeld-Check
  if (!seller.name || !seller.street || !seller.city || !seller.postalCode) {
    return NextResponse.json(
      {
        error: 'seller_incomplete',
        message:
          'Verkäufer-Stammdaten unvollständig. Bitte zuerst unter /staff/admin/settings ergänzen (Name, Straße, PLZ, Ort).',
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

  const xml = generateXRechnungCii(
    {
      number: invoice.number,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      subject: invoice.subject,
      notes: invoice.notes,
      currency: 'EUR',
      vatRate: Number(invoice.vatRate.toString()),
      netAmount: Number(invoice.netAmount.toString()),
      vatAmount: Number(invoice.vatAmount.toString()),
      totalAmount: Number(invoice.totalAmount.toString()),
      positions: invoice.positions.map((p) => ({
        position: p.position,
        description: p.description,
        quantity: Number(p.quantity.toString()),
        unit: p.unit,
        unitPrice: Number(p.unitPrice.toString()),
        netAmount: Number(p.netAmount.toString()),
      })),
    },
    seller,
    {
      name: invoice.client.name,
      street: invoice.client.street,
      postalCode: invoice.client.postalCode,
      city: invoice.client.city,
      countryIso: invoice.client.countryIso ?? 'DE',
      vatId: invoice.client.vatId,
      email: invoice.client.invoiceEmail,
    },
  );

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
