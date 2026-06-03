import { NextResponse, type NextRequest } from 'next/server';
import { getClientIp } from '@/server/rate-limit';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import {
  toCsv,
  csvResponse,
  truncationNote,
  applyRowCap,
  MAX_EXPORT_ROWS,
  type CsvColumn,
} from '@/server/export/csv';

export async function GET(req: NextRequest) {
  const session = await staffAuth();
  if (!session?.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { tenantId, staffId } = session.user;

  const sp = req.nextUrl.searchParams;
  const status = sp.get('status');

  const { rows, truncated } = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const list = await tx.invoice.findMany({
        where:
          status && ['DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED'].includes(status)
            ? { status: status as 'DRAFT' | 'SENT' | 'PAID' | 'OVERDUE' | 'CANCELLED' }
            : undefined,
        orderBy: [{ issueDate: 'desc' }],
        take: MAX_EXPORT_ROWS + 1, // +1 zur Trunkierungs-Erkennung
        include: { client: { select: { name: true, datevNo: true } } },
      });
      const { rows: out, truncated } = applyRowCap(list);
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'invoices.export.csv',
        resourceType: 'invoice',
        after: { rows: out.length, truncated, status: status ?? 'all' },
        ip: getClientIp(req.headers),
        userAgent: req.headers.get('user-agent'),
      });
      return { rows: out, truncated };
    },
  );

  const cols: CsvColumn<(typeof rows)[number]>[] = [
    { key: 'number', label: 'Rechnungs-Nr.', accessor: (r) => r.number },
    { key: 'issueDate', label: 'Datum', accessor: (r) => r.issueDate },
    { key: 'dueDate', label: 'Fällig', accessor: (r) => r.dueDate },
    { key: 'status', label: 'Status', accessor: (r) => r.status },
    { key: 'format', label: 'Format', accessor: (r) => r.format },
    { key: 'client', label: 'Mandant', accessor: (r) => r.client.name },
    { key: 'clientDatev', label: 'Mandant DATEV', accessor: (r) => r.client.datevNo ?? '' },
    { key: 'subject', label: 'Betreff', accessor: (r) => r.subject },
    { key: 'netAmount', label: 'Netto', accessor: (r) => Number(r.netAmount.toString()) },
    { key: 'vatRate', label: 'USt-Satz %', accessor: (r) => Number(r.vatRate.toString()) },
    { key: 'vatAmount', label: 'USt', accessor: (r) => Number(r.vatAmount.toString()) },
    { key: 'totalAmount', label: 'Brutto', accessor: (r) => Number(r.totalAmount.toString()) },
    { key: 'sentAt', label: 'Versendet', accessor: (r) => r.sentAt },
    { key: 'paidAt', label: 'Bezahlt', accessor: (r) => r.paidAt },
  ];

  return csvResponse(
    `rechnungen-${new Date().toISOString().slice(0, 10)}`,
    toCsv(rows, cols, truncated ? { truncatedNote: truncationNote(MAX_EXPORT_ROWS) } : undefined),
    { truncated },
  );
}
