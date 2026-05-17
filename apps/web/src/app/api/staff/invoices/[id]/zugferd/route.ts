import { NextResponse, type NextRequest } from 'next/server';
import { getClientIp } from '@/server/rate-limit';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { generateXRechnungCii } from '@/server/invoicing/xrechnung';
import { generateZugferdPdf } from '@/server/invoicing/zugferd';
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
  // ZUGFeRD-PDFs tragen Verkäuferdaten + Mandanten-Adresse + USt-ID — bei
  // einem RLS-Migrations-Drift wäre ein Cross-Tenant-Read der GAU.
  // findFirst statt findUnique, weil (id, tenantId) zwar logisch unique
  // sind, aber kein Compound-Unique-Constraint in Prisma deklariert ist.
  const invoice = await withTenantContext(ctx, (tx) =>
    tx.invoice.findFirst({
      where: { id, tenantId },
      include: {
        client: true,
        positions: { orderBy: { position: 'asc' } },
      },
    }),
  );
  if (!invoice) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const seller = await readSellerInfo(ctx);

  if (!seller.name || !seller.street || !seller.city || !seller.postalCode) {
    return NextResponse.json(
      {
        error: 'seller_incomplete',
        message: 'Verkäufer-Stammdaten unvollständig (Name, Straße, PLZ, Ort).',
      },
      { status: 422 },
    );
  }
  if (!invoice.client.street || !invoice.client.city || !invoice.client.postalCode) {
    return NextResponse.json(
      {
        error: 'buyer_incomplete',
        message: 'Mandanten-Adresse unvollständig (Straße, PLZ, Ort).',
      },
      { status: 422 },
    );
  }

  const xrechnungInput = {
    number: invoice.number,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    subject: invoice.subject,
    notes: invoice.notes,
    currency: 'EUR' as const,
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
  };
  const buyerInput = {
    name: invoice.client.name,
    street: invoice.client.street,
    postalCode: invoice.client.postalCode,
    city: invoice.client.city,
    countryIso: invoice.client.countryIso ?? 'DE',
    vatId: invoice.client.vatId,
    email: invoice.client.invoiceEmail,
  };

  const ciiXml = generateXRechnungCii(xrechnungInput, seller, buyerInput);
  const pdfBytes = await generateZugferdPdf(xrechnungInput, seller, buyerInput, ciiXml);

  // Audit
  await withTenantContext(ctx, async (tx) => {
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'invoice.zugferd.download',
      resourceType: 'invoice',
      resourceId: id,
      after: {
        number: invoice.number,
        format: 'ZUGFeRD/Factur-X EN16931',
        sizeBytes: pdfBytes.length,
      },
      ip: getClientIp(req.headers),
      userAgent: req.headers.get('user-agent'),
    });
  });

  const fileName = `zugferd-${invoice.number.replace(/[^A-Za-z0-9_-]/g, '_')}.pdf`;
  return new NextResponse(Buffer.from(pdfBytes), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Content-Length': String(pdfBytes.length),
      'Cache-Control': 'no-store',
    },
  });
}
