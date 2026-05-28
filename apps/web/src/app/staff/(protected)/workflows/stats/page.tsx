// =============================================================================
// /staff/workflows/stats — Workflow-Auswertungen
//
// Pro Vorlage:
//   - Anzahl laufender + abgeschlossener Instanzen
//   - Durchschnittliche Durchlaufzeit (Start → COMPLETED) in Tagen
//   - Engpass: Item-Position mit längster Liegezeit (open-time)
// =============================================================================

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Workflow, Clock, AlertTriangle } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';

const dayFmt = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });

export default async function WorkflowStatsPage() {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  const { tenantId, staffId } = session.user;

  const data = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const templates = await tx.workflowTemplate.findMany({
        orderBy: [{ active: 'desc' }, { name: 'asc' }],
        include: {
          instances: {
            select: {
              id: true,
              status: true,
              startedAt: true,
              completedAt: true,
              items: { select: { position: true, title: true, doneAt: true, createdAt: true } },
            },
          },
        },
      });
      return templates;
    },
  );

  const rows = data.map((tpl) => {
    const total = tpl.instances.length;
    const active = tpl.instances.filter((i) => i.status === 'ACTIVE' || i.status === 'PAUSED').length;
    const completed = tpl.instances.filter((i) => i.status === 'COMPLETED');
    const cancelled = tpl.instances.filter((i) => i.status === 'CANCELLED').length;

    // Durchschnittliche Durchlaufzeit (nur COMPLETED)
    let avgDays: number | null = null;
    if (completed.length > 0) {
      const sum = completed.reduce((acc, i) => {
        if (!i.completedAt) return acc;
        return acc + (i.completedAt.getTime() - i.startedAt.getTime());
      }, 0);
      avgDays = sum / completed.length / (24 * 60 * 60 * 1000);
    }

    // Engpass: pro Position die durchschnittliche Liegezeit (createdAt → doneAt) der erledigten Items.
    // Nehme nur abgeschlossene Items, sonst dominieren offene Bottlenecks zu sehr.
    const byPosition = new Map<number, { title: string; totalMs: number; count: number }>();
    for (const inst of tpl.instances) {
      for (const it of inst.items) {
        if (!it.doneAt) continue;
        const ms = it.doneAt.getTime() - it.createdAt.getTime();
        const cur = byPosition.get(it.position) ?? { title: it.title, totalMs: 0, count: 0 };
        cur.totalMs += ms;
        cur.count += 1;
        byPosition.set(it.position, cur);
      }
    }
    const positions = Array.from(byPosition.entries())
      .map(([pos, x]) => ({ pos, title: x.title, avgDays: x.totalMs / x.count / (24 * 60 * 60 * 1000) }))
      .sort((a, b) => b.avgDays - a.avgDays);
    const bottleneck = positions[0];

    return {
      id: tpl.id,
      name: tpl.name,
      active: tpl.active,
      total,
      activeCount: active,
      completed: completed.length,
      cancelled,
      avgDays,
      bottleneck,
    };
  });

  return (
    <div className="p-8 max-w-6xl">
      <Link
        href="/staff/workflows"
        className="back-link"
      >
        <ArrowLeft className="h-4 w-4" /> Zurück zu Workflows
      </Link>

      <div className="mb-6">
        <h1 className="page-title">
          <Workflow className="h-6 w-6 text-brand-600" />
          Workflow-Auswertungen
        </h1>
        <p className="text-muted text-sm">
          Durchschnittliche Durchlaufzeit pro Vorlage und der Schritt mit der
          längsten durchschnittlichen Bearbeitungszeit (Engpass).
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
                <th className="text-left px-6 py-3 text-xs font-medium text-muted uppercase">Vorlage</th>
                <th className="text-right px-6 py-3 text-xs font-medium text-muted uppercase">Laufend</th>
                <th className="text-right px-6 py-3 text-xs font-medium text-muted uppercase">Abgeschlossen</th>
                <th className="text-right px-6 py-3 text-xs font-medium text-muted uppercase">Abgebrochen</th>
                <th className="text-right px-6 py-3 text-xs font-medium text-muted uppercase">
                  <Clock className="h-3 w-3 inline mr-1" />
                  Ø Durchlaufzeit
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
                    {r.avgDays != null ? `${dayFmt.format(r.avgDays)} Tage` : '—'}
                  </td>
                  <td className="px-6 py-3 text-xs">
                    {r.bottleneck ? (
                      <span>
                        <span className="text-muted">#{r.bottleneck.pos + 1}</span>{' '}
                        <span className="text-primary">{r.bottleneck.title}</span>
                        <span className="text-disabled ml-1">
                          Ø {dayFmt.format(r.bottleneck.avgDays)} T
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
        Durchlaufzeit zählt nur abgeschlossene Instanzen (Start → COMPLETED).
        Engpass-Analyse nur erledigte Items pro Position über alle Instanzen einer Vorlage.
      </p>
    </div>
  );
}

export const dynamic = 'force-dynamic';
