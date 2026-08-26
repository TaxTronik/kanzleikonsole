import { requireStaffPage } from '@/server/auth/staff-page';

import { fmtDateTimeShort } from '@/lib/fmt';
import { getQueuesStatus } from '@/server/jobs/queue-status';

// Nicht cachen: der Status soll bei jedem Aufruf frisch aus Redis kommen.

export default async function AdminJobsPage() {
  await requireStaffPage({ admin: true });

  const queues = await getQueuesStatus();
  const problems = queues.filter((q) => q.stale || q.failed > 0);

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-primary mb-1">System → Jobs</h1>
        <p className="text-muted text-sm max-w-3xl">
          Verarbeitungsstatus der Hintergrund-Jobs (BullMQ). „Veraltet" = der letzte erfolgreiche
          Lauf liegt außerhalb des zum tatsächlichen Zeitplan gehörenden Karenzfensters — ein
          Hinweis auf einen ausgefallenen periodischen Job. Fehlgeschlagene Jobs (`failed`) sollten
          geprüft werden; die letzte Fehlermeldung steht rechts.
        </p>
      </div>

      {problems.length > 0 && (
        <div className="alert-warning mb-4 text-sm">
          <strong>{problems.length}</strong> Queue(s) mit veraltetem Lauf oder Fehlern — siehe rot
          markierte Zeilen.
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-default">
                <th className="th">Queue</th>
                <th className="th th-right">Wartend</th>
                <th className="th th-right">Aktiv</th>
                <th className="th th-right">Fehlgeschlagen</th>
                <th className="th">Letzter Erfolg</th>
                <th className="th">Letzter Fehler</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {queues.map((q) => {
                const problem = q.stale || q.failed > 0;
                return (
                  <tr key={q.name} className={problem ? 'bg-red-50/50' : 'hover:bg-gray-50'}>
                    <td className="px-4 py-3 font-mono text-primary">
                      {q.name}
                      {q.stale && <span className="badge-red ml-2 text-[10px]">veraltet</span>}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{q.waiting}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{q.active}</td>
                    <td
                      className={`px-4 py-3 text-right tabular-nums ${q.failed > 0 ? 'text-red-700 font-medium' : 'text-muted'}`}
                    >
                      {q.failed}
                    </td>
                    <td className="px-4 py-3 text-secondary">
                      {q.lastCompletedAt ? fmtDateTimeShort(new Date(q.lastCompletedAt)) : '—'}
                    </td>
                    <td
                      className="px-4 py-3 text-xs text-red-700 max-w-xs truncate"
                      title={q.lastFailedReason ?? ''}
                    >
                      {q.lastFailedReason
                        ? `${q.lastFailedReason}${q.lastFailedAt ? ` (${fmtDateTimeShort(new Date(q.lastFailedAt))})` : ''}`
                        : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
