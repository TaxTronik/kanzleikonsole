import { NextResponse, type NextRequest } from 'next/server';
import { getClientIp, checkStaffExportLimit } from '@/server/rate-limit';
import { staffAuth } from '@/server/auth/staff';
import { accessibleClientsWhereFor } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import {
  clientListWhere,
  clientOrderBy,
  parseClientListFilters,
} from '@/app/staff/(protected)/clients/list-query';
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
  const rl = await checkStaffExportLimit('clients', staffId);
  if (!rl.ok) {
    return NextResponse.json({ error: 'rate_limited', retryAfter: rl.retryAfter }, { status: 429 });
  }

  const sp = req.nextUrl.searchParams;
  const filters = parseClientListFilters({
    q: sp.get('q'),
    status: sp.get('status'),
    onboarding: sp.get('onboarding'),
    kind: sp.get('kind'),
    mine: sp.get('mine'),
    sort: sp.get('sort'),
    dir: sp.get('dir'),
  });
  const { rows, truncated } = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      // Zugriffsmodell (vertraulich-Flag / RESTRICTED): gesperrte Mandanten
      // tauchen nicht im CSV auf.
      const list = await tx.client.findMany({
        where: clientListWhere(filters, staffId, await accessibleClientsWhereFor(tx, session)),
        orderBy: clientOrderBy(filters.sort, filters.dir),
        take: MAX_EXPORT_ROWS + 1, // +1 zur Trunkierungs-Erkennung
        select: {
          datevNo: true,
          addisonNo: true,
          name: true,
          kind: true,
          allowActive: true,
          street: true,
          postalCode: true,
          city: true,
          countryIso: true,
          vatId: true,
          invoiceEmail: true,
          createdAt: true,
          _count: {
            select: { documents: { where: { deletedAt: null } }, invoices: true, requests: true },
          },
        },
      });
      const { rows: out, truncated } = applyRowCap(list);
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'clients.export.csv',
        resourceType: 'client',
        after: {
          rows: out.length,
          truncated,
          searchApplied: Boolean(filters.q),
          mine: filters.mine,
          status: filters.status ?? 'all',
          onboarding: filters.onboarding ?? 'all',
          kind: filters.kind ?? 'all',
        },
        ip: getClientIp(req.headers),
        userAgent: req.headers.get('user-agent'),
      });
      return { rows: out, truncated };
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

  return csvResponse(
    `mandanten-${new Date().toISOString().slice(0, 10)}`,
    toCsv(rows, cols, truncated ? { truncatedNote: truncationNote(MAX_EXPORT_ROWS) } : undefined),
    { truncated },
  );
}
