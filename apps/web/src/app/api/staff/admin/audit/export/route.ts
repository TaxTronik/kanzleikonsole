import { NextResponse, type NextRequest } from 'next/server';
import { getClientIp } from '@/server/rate-limit';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { toCsv, csvResponse, type CsvColumn } from '@/server/export/csv';
import type { Prisma } from '@prisma/client';

const MAX_ROWS = 10_000;

export async function GET(req: NextRequest) {
  const session = await staffAuth();
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isStaffAdmin(session)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const { tenantId, staffId } = session.user;

  const sp = req.nextUrl.searchParams;
  const where: Prisma.AuditLogWhereInput = {};
  if (sp.get('action')) where.action = { contains: sp.get('action')!, mode: 'insensitive' };
  const at = sp.get('actorType');
  if (at && ['STAFF', 'CLIENT_CONTACT', 'SYSTEM'].includes(at)) {
    where.actorType = at as 'STAFF' | 'CLIENT_CONTACT' | 'SYSTEM';
  }
  if (sp.get('resourceType')) where.resourceType = sp.get('resourceType')!;
  if (sp.get('from') || sp.get('to')) {
    where.occurredAt = {};
    if (sp.get('from')) where.occurredAt.gte = new Date(sp.get('from')!);
    if (sp.get('to')) {
      const to = new Date(sp.get('to')!);
      to.setHours(23, 59, 59, 999);
      where.occurredAt.lte = to;
    }
  }

  const rows = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const list = await tx.auditLog.findMany({
        where,
        orderBy: { id: 'desc' },
        take: MAX_ROWS,
      });

      // Audit den Export selbst
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'audit.export.csv',
        resourceType: 'audit_log',
        after: { rows: list.length, filters: Object.fromEntries(sp.entries()) },
        ip: getClientIp(req.headers),
        userAgent: req.headers.get('user-agent'),
      });
      return list;
    },
  );

  const cols: CsvColumn<(typeof rows)[number]>[] = [
    { key: 'id', label: 'ID', accessor: (r) => r.id },
    { key: 'occurredAt', label: 'Zeitpunkt', accessor: (r) => r.occurredAt },
    { key: 'actorType', label: 'Akteur-Typ', accessor: (r) => r.actorType },
    { key: 'actorId', label: 'Akteur-ID', accessor: (r) => r.actorId ?? '' },
    { key: 'action', label: 'Action', accessor: (r) => r.action },
    { key: 'resourceType', label: 'Ressource', accessor: (r) => r.resourceType },
    { key: 'resourceId', label: 'Ressourcen-ID', accessor: (r) => r.resourceId ?? '' },
    { key: 'ip', label: 'IP', accessor: (r) => r.ip ?? '' },
    {
      key: 'thisHash',
      label: 'Hash',
      accessor: (r) => Buffer.from(r.thisHash).toString('hex'),
    },
    {
      key: 'prevHash',
      label: 'Vorgänger-Hash',
      accessor: (r) => Buffer.from(r.prevHash).toString('hex'),
    },
  ];

  return csvResponse(`audit-${new Date().toISOString().slice(0, 10)}`, toCsv(rows, cols));
}
