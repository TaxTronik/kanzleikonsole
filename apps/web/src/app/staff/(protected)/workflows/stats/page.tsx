// =============================================================================
// /staff/workflows/stats — Workflow-Auswertungen
//
// Pro Vorlage:
//   - Anzahl laufender + abgeschlossener Instanzen
//   - Durchschnittliche Durchlaufzeit (Start → COMPLETED) in Tagen
//   - Engpass: Item-Position mit längster Liegezeit (open-time)
// =============================================================================

import Link from 'next/link';
import { ArrowLeft, Workflow, Clock, AlertTriangle } from 'lucide-react';
import { requireStaffPage } from '@/server/auth/staff-page';
import { Prisma, withTenantContext } from '@taxtronik/db';
import { fmtDecimal } from '@/lib/fmt';

interface WorkflowDurationAggregate {
  templateId: string;
  avgDays: number;
}

interface WorkflowBottleneckAggregate {
  templateId: string;
  position: number;
  title: string;
  avgDays: number;
}

export default async function WorkflowStatsPage() {
  const session = await requireStaffPage();
  const { tenantId, staffId } = session.user;

  const data = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const [templates, instanceCounts, durations, bottlenecks] = await Promise.all([
        tx.workflowTemplate.findMany({
          where: { tenantId },
          orderBy: [{ active: 'desc' }, { name: 'asc' }],
          select: { id: true, name: true, active: true },
        }),
        tx.workflowInstance.groupBy({
          by: ['templateId', 'status'],
          where: { tenantId, templateId: { not: null } },
          _count: { _all: true },
        }),
        tx.$queryRaw<WorkflowDurationAggregate[]>(Prisma.sql`
          SELECT
            instance."template_id" AS "templateId",
            AVG(
              EXTRACT(EPOCH FROM (instance."completed_at" - instance."started_at")) / 86400.0
            )::double precision AS "avgDays"
          FROM "workflow_instance" instance
          WHERE instance."tenant_id" = ${tenantId}::uuid
            AND instance."template_id" IS NOT NULL
            AND instance."status" = 'COMPLETED'
            AND instance."completed_at" IS NOT NULL
          GROUP BY instance."template_id"
        `),
        tx.$queryRaw<WorkflowBottleneckAggregate[]>(Prisma.sql`
          WITH position_stats AS (
            SELECT
              instance."template_id" AS "templateId",
              item."position" AS "position",
              MIN(item."title") AS "title",
              AVG(
                EXTRACT(EPOCH FROM (item."done_at" - item."created_at")) / 86400.0
              )::double precision AS "avgDays"
            FROM "workflow_item" item
            INNER JOIN "workflow_instance" instance ON instance."id" = item."instance_id"
            WHERE instance."tenant_id" = ${tenantId}::uuid
              AND instance."template_id" IS NOT NULL
              AND item."done_at" IS NOT NULL
            GROUP BY instance."template_id", item."position"
          ), ranked AS (
            SELECT
              "templateId",
              "position",
              "title",
              "avgDays",
              ROW_NUMBER() OVER (
                PARTITION BY "templateId"
                ORDER BY "avgDays" DESC, "position" ASC
              ) AS "rank"
            FROM position_stats
          )
          SELECT "templateId", "position", "title", "avgDays"
          FROM ranked
          WHERE "rank" = 1
        `),
      ]);

      return { templates, instanceCounts, durations, bottlenecks };
    },
  );

  const countsByTemplate = new Map<
    string,
    { total: number; active: number; completed: number; cancelled: number }
  >();
  for (const aggregate of data.instanceCounts) {
    if (!aggregate.templateId) continue;
    const counts = countsByTemplate.get(aggregate.templateId) ?? {
      total: 0,
      active: 0,
      completed: 0,
      cancelled: 0,
    };
    const count = aggregate._count._all;
    counts.total += count;
    if (aggregate.status === 'ACTIVE' || aggregate.status === 'PAUSED') counts.active += count;
    if (aggregate.status === 'COMPLETED') counts.completed += count;
    if (aggregate.status === 'CANCELLED') counts.cancelled += count;
    countsByTemplate.set(aggregate.templateId, counts);
  }

  const durationsByTemplate = new Map(data.durations.map((row) => [row.templateId, row.avgDays]));
  const bottlenecksByTemplate = new Map(data.bottlenecks.map((row) => [row.templateId, row]));

  const rows = data.templates.map((tpl) => {
    const counts = countsByTemplate.get(tpl.id) ?? {
      total: 0,
      active: 0,
      completed: 0,
      cancelled: 0,
    };
    const bottleneckAggregate = bottlenecksByTemplate.get(tpl.id);

    return {
      id: tpl.id,
      name: tpl.name,
      active: tpl.active,
      total: counts.total,
      activeCount: counts.active,
      completed: counts.completed,
      cancelled: counts.cancelled,
      avgDays: durationsByTemplate.get(tpl.id) ?? null,
      bottleneck: bottleneckAggregate
        ? {
            pos: bottleneckAggregate.position,
            title: bottleneckAggregate.title,
            avgDays: bottleneckAggregate.avgDays,
          }
        : undefined,
    };
  });

  return (
    <div className="p-8 max-w-6xl">
      <Link href="/staff/workflows" className="back-link">
        <ArrowLeft className="h-4 w-4" /> Zurück zu Workflows
      </Link>

      <div className="mb-6">
        <h1 className="page-title">
          <Workflow className="h-6 w-6 text-brand-600" />
          Workflow-Auswertungen
        </h1>
        <p className="text-muted text-sm">
          Durchschnittliche Durchlaufzeit pro Vorlage und der Schritt mit der längsten
          durchschnittlichen Bearbeitungszeit (Engpass).
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="card p-10 text-center text-sm text-disabled">
          Noch keine Workflow-Vorlagen.
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-default">
              <tr>
                <th className="text-left px-6 py-3 text-xs font-medium text-muted uppercase">
                  Vorlage
                </th>
                <th className="text-right px-6 py-3 text-xs font-medium text-muted uppercase">
                  Laufend
                </th>
                <th className="text-right px-6 py-3 text-xs font-medium text-muted uppercase">
                  Abgeschlossen
                </th>
                <th className="text-right px-6 py-3 text-xs font-medium text-muted uppercase">
                  Abgebrochen
                </th>
                <th className="text-right px-6 py-3 text-xs font-medium text-muted uppercase">
                  <Clock className="h-3 w-3 inline mr-1" />Ø Durchlaufzeit
                </th>
                <th className="text-left px-6 py-3 text-xs font-medium text-muted uppercase">
                  <AlertTriangle className="h-3 w-3 inline mr-1" />
                  Engpass-Schritt
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {rows.map((r) => (
                <tr key={r.id} className={r.active ? '' : 'opacity-60'}>
                  <td className="px-6 py-3">
                    <Link
                      href={`/staff/workflows/templates/${r.id}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {r.name}
                    </Link>
                  </td>
                  <td className="px-6 py-3 text-right text-secondary">{r.activeCount}</td>
                  <td className="px-6 py-3 text-right text-secondary">{r.completed}</td>
                  <td className="px-6 py-3 text-right text-secondary">{r.cancelled}</td>
                  <td className="px-6 py-3 text-right text-secondary">
                    {r.avgDays != null ? `${fmtDecimal(r.avgDays, 1)} Tage` : '—'}
                  </td>
                  <td className="px-6 py-3 text-xs">
                    {r.bottleneck ? (
                      <span>
                        <span className="text-muted">#{r.bottleneck.pos + 1}</span>{' '}
                        <span className="text-primary">{r.bottleneck.title}</span>
                        <span className="text-disabled ml-1">
                          Ø {fmtDecimal(r.bottleneck.avgDays, 1)} T
                        </span>
                      </span>
                    ) : (
                      <span className="text-disabled">— keine Daten</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-muted mt-4">
        Durchlaufzeit zählt nur abgeschlossene Instanzen (Start → COMPLETED). Engpass-Analyse nur
        erledigte Items pro Position über alle Instanzen einer Vorlage.
      </p>
    </div>
  );
}
