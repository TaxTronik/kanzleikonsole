import { NextResponse, type NextRequest } from 'next/server';
import { getClientIp, checkStaffExportLimit } from '@/server/rate-limit';
import { staffAuth } from '@/server/auth/staff';
import { accessibleClientsWhereFor } from '@/server/auth/rbac';
import {
  parseRequestListFilters,
  requestListWhere,
  requestListOrder,
} from '@/server/requests/list-filters';
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

  // Per-User-Rate-Limit (Defense in Depth): Exporte sind teuer + datenreich.
  const rl = await checkStaffExportLimit('requests', staffId);
  if (!rl.ok) {
    return NextResponse.json({ error: 'rate_limited', retryAfter: rl.retryAfter }, { status: 429 });
  }

  const sp = req.nextUrl.searchParams;
  const filters = parseRequestListFilters({
    status: sp.get('status'),
    q: sp.get('q'),
    mine: sp.get('mine'),
    sort: sp.get('sort'),
    dir: sp.get('dir'),
  });

  const { rows, truncated } = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      // Zugriffsmodell (vertraulich-Flag / RESTRICTED): Anforderungen
      // gesperrter Mandanten tauchen nicht im CSV auf.
      const list = await tx.request.findMany({
        where: requestListWhere(filters, staffId, await accessibleClientsWhereFor(tx, session)),
        orderBy: requestListOrder(filters),
        take: MAX_EXPORT_ROWS + 1, // +1 zur Trunkierungs-Erkennung
        select: {
          createdAt: true,
          title: true,
          status: true,
          priority: true,
          dueAt: true,
          closedAt: true,
          client: { select: { name: true, datevNo: true } },
          _count: { select: { responses: true } },
        },
      });
      const { rows: out, truncated } = applyRowCap(list);
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'requests.export.csv',
        resourceType: 'request',
        after: {
          rows: out.length,
          truncated,
          status: filters.status ?? 'all',
          mine: filters.mine,
          searchApplied: Boolean(filters.q),
        },
        ip: getClientIp(req.headers),
        userAgent: req.headers.get('user-agent'),
      });
      return { rows: out, truncated };
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

  return csvResponse(
    `anforderungen-${new Date().toISOString().slice(0, 10)}`,
    toCsv(rows, cols, truncated ? { truncatedNote: truncationNote(MAX_EXPORT_ROWS) } : undefined),
    { truncated },
  );
}
