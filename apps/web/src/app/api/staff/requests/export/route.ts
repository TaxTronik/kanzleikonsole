import { NextResponse, type NextRequest } from 'next/server';
import { getClientIp } from '@/server/rate-limit';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { toCsv, csvResponse, type CsvColumn } from '@/server/export/csv';

// Harte Obergrenze (wie audit/export): deckelt Speicher UND den synchronen
// CSV-String-Aufbau (Event-Loop-Block) — Anforderungen wachsen über Jahre monoton.
const MAX_ROWS = 10_000;

export async function GET(req: NextRequest) {
  const session = await staffAuth();
  if (!session?.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { tenantId, staffId } = session.user;

  const sp = req.nextUrl.searchParams;
  const status = sp.get('status');

  const rows = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const list = await tx.request.findMany({
        where:
          status && ['OPEN', 'IN_PROGRESS', 'RESPONDED', 'CLOSED', 'CANCELLED'].includes(status)
            ? { status: status as 'OPEN' | 'IN_PROGRESS' | 'RESPONDED' | 'CLOSED' | 'CANCELLED' }
            : undefined,
        orderBy: [{ status: 'asc' }, { dueAt: 'asc' }, { createdAt: 'desc' }],
        take: MAX_ROWS,
        include: {
          client: { select: { name: true, datevNo: true } },
          _count: { select: { responses: true } },
        },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'requests.export.csv',
        resourceType: 'request',
        after: { rows: list.length, status: status ?? 'all' },
        ip: getClientIp(req.headers),
        userAgent: req.headers.get('user-agent'),
      });
      return list;
    },
  );

  const cols: CsvColumn<(typeof rows)[number]>[] = [
    { key: 'createdAt', label: 'Erstellt', accessor: (r) => r.createdAt },
    { key: 'client', label: 'Mandant', accessor: (r) => r.client.name },
    { key: 'clientDatev', label: 'DATEV', accessor: (r) => r.client.datevNo ?? '' },
    { key: 'title', label: 'Titel', accessor: (r) => r.title },
    { key: 'status', label: 'Status', accessor: (r) => r.status },
    { key: 'priority', label: 'Priorität', accessor: (r) => r.priority },
    { key: 'dueAt', label: 'Fällig', accessor: (r) => r.dueAt },
    { key: 'responses', label: 'Antworten', accessor: (r) => r._count.responses },
    { key: 'closedAt', label: 'Geschlossen', accessor: (r) => r.closedAt },
  ];

  return csvResponse(`anforderungen-${new Date().toISOString().slice(0, 10)}`, toCsv(rows, cols));
}
