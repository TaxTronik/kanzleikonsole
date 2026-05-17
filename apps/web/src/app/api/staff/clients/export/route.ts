import { NextResponse, type NextRequest } from 'next/server';
import { getClientIp } from '@/server/rate-limit';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { toCsv, csvResponse, type CsvColumn } from '@/server/export/csv';

export async function GET(req: NextRequest) {
  const session = await staffAuth();
  if (!session?.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { tenantId, staffId } = session.user;

  const rows = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const list = await tx.client.findMany({
        orderBy: { name: 'asc' },
        include: { _count: { select: { documents: true, invoices: true, requests: true } } },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'clients.export.csv',
        resourceType: 'client',
        after: { rows: list.length },
        ip: getClientIp(req.headers),
        userAgent: req.headers.get('user-agent'),
      });
      return list;
    },
  );

  const cols: CsvColumn<(typeof rows)[number]>[] = [
    { key: 'datevNo', label: 'DATEV-Nr.', accessor: (r) => r.datevNo ?? '' },
    { key: 'addisonNo', label: 'Addison-Nr.', accessor: (r) => r.addisonNo ?? '' },
    { key: 'name', label: 'Name', accessor: (r) => r.name },
    { key: 'kind', label: 'Typ', accessor: (r) => r.kind },
    { key: 'allowActive', label: 'Aktiv', accessor: (r) => (r.allowActive ? 'Ja' : 'Nein') },
    { key: 'street', label: 'Straße', accessor: (r) => r.street ?? '' },
    { key: 'postalCode', label: 'PLZ', accessor: (r) => r.postalCode ?? '' },
    { key: 'city', label: 'Ort', accessor: (r) => r.city ?? '' },
    { key: 'countryIso', label: 'Land', accessor: (r) => r.countryIso ?? '' },
    { key: 'vatId', label: 'USt-ID', accessor: (r) => r.vatId ?? '' },
    { key: 'invoiceEmail', label: 'Rechnungs-E-Mail', accessor: (r) => r.invoiceEmail ?? '' },
    { key: 'createdAt', label: 'Angelegt', accessor: (r) => r.createdAt },
    { key: 'documents', label: 'Dokumente', accessor: (r) => r._count.documents },
    { key: 'invoices', label: 'Rechnungen', accessor: (r) => r._count.invoices },
    { key: 'requests', label: 'Anforderungen', accessor: (r) => r._count.requests },
  ];

  return csvResponse(`mandanten-${new Date().toISOString().slice(0, 10)}`, toCsv(rows, cols));
}
