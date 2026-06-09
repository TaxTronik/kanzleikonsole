import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getClientIp } from '@/server/rate-limit';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
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
import type { Prisma } from '@prisma/client';

// Befund 11: Query-Parameter validieren statt `new Date(sp.get('from')!)` —
// ein kaputter Wert ergab Invalid Date → Prisma-Fehler → 500. Leere Strings
// (z. B. `?action=`) zählen wie „nicht gesetzt" (Verhalten wie vorher).
const QuerySchema = z.object({
  action: z.string().max(200).optional(),
  actorType: z.enum(['STAFF', 'CLIENT_CONTACT', 'SYSTEM']).optional(),
  resourceType: z.string().max(200).optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
});

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
  const parsed = QuerySchema.safeParse({
    action: sp.get('action') || undefined,
    actorType: sp.get('actorType') || undefined,
    resourceType: sp.get('resourceType') || undefined,
    from: sp.get('from') || undefined,
    to: sp.get('to') || undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const q = parsed.data;

  const where: Prisma.AuditLogWhereInput = {};
  if (q.action) where.action = { contains: q.action, mode: 'insensitive' };
  if (q.actorType) where.actorType = q.actorType;
  if (q.resourceType) where.resourceType = q.resourceType;
  if (q.from || q.to) {
    where.occurredAt = {};
    if (q.from) where.occurredAt.gte = new Date(q.from);
    if (q.to) {
      const to = new Date(q.to);
      to.setHours(23, 59, 59, 999);
      where.occurredAt.lte = to;
    }
  }

  const { rows, truncated } = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      // +1 lesen, um Trunkierung zu ERKENNEN (kein Extra-count nötig).
      const list = await tx.auditLog.findMany({
        where,
        orderBy: { id: 'desc' },
        take: MAX_EXPORT_ROWS + 1,
      });
      const { rows: out, truncated } = applyRowCap(list);

      // Audit den Export selbst — inkl. Trunkierungs-Flag (Compliance: ein
      // still gekürzter Prüfer-Export muss im Audit-Trail erkennbar sein).
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'audit.export.csv',
        resourceType: 'audit_log',
        after: { rows: out.length, truncated, filters: Object.fromEntries(sp.entries()) },
        ip: getClientIp(req.headers),
        userAgent: req.headers.get('user-agent'),
      });
      return { rows: out, truncated };
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

  return csvResponse(
    `audit-${new Date().toISOString().slice(0, 10)}`,
    toCsv(rows, cols, truncated ? { truncatedNote: truncationNote(MAX_EXPORT_ROWS) } : undefined),
    { truncated },
  );
}
