import type { Prisma } from '@prisma/client';
import { NextResponse, type NextRequest } from 'next/server';
import { getClientIp, checkStaffExportLimit } from '@/server/rate-limit';
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
import {
  AUDIT_CATEGORIES,
  AuditQuerySchema,
  auditCategory,
  auditWhere,
} from '@/server/audit/query';

/**
 * P-12: Ein Sammel-Download trägt seine Dokumente nicht in resource_id, sondern
 * im Nachher-Zustand (`document.download.bulk`: documentCount, documentIds).
 * Weil der Export before/after sonst nicht enthält, fehlten die IDs hier;
 * diese Spalte weist Anzahl und alle IDs aus. Andere Ereignisse bleiben leer.
 */
function auditDetails(row: { action: string; after: Prisma.JsonValue }): string {
  const after = row.after;
  if (row.action !== 'document.download.bulk') return '';
  if (!after || typeof after !== 'object' || Array.isArray(after)) return '';
  const ids = Array.isArray(after['documentIds'])
    ? after['documentIds'].filter((id): id is string => typeof id === 'string')
    : [];
  const count = typeof after['documentCount'] === 'number' ? after['documentCount'] : ids.length;
  return `${count} Dokumente: ${ids.join(' ')}`;
}

export async function GET(req: NextRequest) {
  const session = await staffAuth();
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isStaffAdmin(session)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const { tenantId, staffId } = session.user;

  // Per-User-Rate-Limit (Defense in Depth): Exporte sind teuer + datenreich.
  const rl = await checkStaffExportLimit('audit', staffId);
  if (!rl.ok) {
    return NextResponse.json({ error: 'rate_limited', retryAfter: rl.retryAfter }, { status: 429 });
  }

  const sp = req.nextUrl.searchParams;
  const parsed = AuditQuerySchema.safeParse({
    action: sp.get('action') || undefined,
    actorType: sp.get('actorType') || undefined,
    resourceType: sp.get('resourceType') || undefined,
    category: sp.get('category') || undefined,
    sort: sp.get('sort') || undefined,
    from: sp.get('from') || undefined,
    to: sp.get('to') || undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'validation', issues: parsed.error.issues }, { status: 400 });
  }
  const q = parsed.data;

  const where = auditWhere(q);

  const { rows, truncated } = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      // +1 lesen, um Trunkierung zu ERKENNEN (kein Extra-count nötig).
      const list = await tx.auditLog.findMany({
        where,
        orderBy: { id: q.sort === 'oldest' ? 'asc' : 'desc' },
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
        // Nur die zod-validierten Filter in die (unveränderliche) Hash-Chain —
        // NICHT die rohen Query-Strings: sonst könnte ein Aufrufer beliebige
        // Junk-Parameter dauerhaft mit anhängen.
        after: { rows: out.length, truncated, filters: q },
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
    {
      key: 'category',
      label: 'Bereich',
      accessor: (r) => AUDIT_CATEGORIES[auditCategory(r.action)],
    },
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
    // Hinten angefügt: bestehende Spaltenpositionen bleiben unverändert.
    { key: 'details', label: 'Details', accessor: auditDetails },
  ];

  return csvResponse(
    `audit-${new Date().toISOString().slice(0, 10)}`,
    toCsv(rows, cols, truncated ? { truncatedNote: truncationNote(MAX_EXPORT_ROWS) } : undefined),
    { truncated },
  );
}
