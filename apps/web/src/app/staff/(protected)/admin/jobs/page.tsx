import { requireStaffPage } from '@/server/auth/staff-page';

import { fmtDateTimeShort, fmtNumber } from '@/lib/fmt';
import { describeBacklogThreshold } from '@/server/jobs/maintenance-backlog';
import { getQueuesStatus, type QueueStatus } from '@/server/jobs/queue-status';

// Nicht cachen: der Status soll bei jedem Aufruf frisch aus Redis kommen.

/** P-17/B14: Rückstand des letzten Laufs, Fälligkeit des ältesten Eintrags und Alarm. */
function BacklogCell({ queue }: { queue: QueueStatus }) {
  const status = queue.backlogStatus;
  const pending = (queue.backlog ?? 0) > 0;
  return (
    <td
      className={`px-4 py-3 text-right tabular-nums ${pending ? 'text-amber-700 font-medium' : 'text-muted'}`}
    >
      {fmtNumber(queue.backlog)}
      {status?.alarm && <span className="badge-red ml-2 text-[10px]">Alarm</span>}
      {status?.oldestDueAt && (
        <div className="text-xs font-normal text-secondary">
          ältester fällig seit {fmtDateTimeShort(new Date(status.oldestDueAt))}
        </div>
      )}
    </td>
  );
}

export default async function AdminJobsPage() {
  await requireStaffPage({ admin: true });

  const queues = await getQueuesStatus();
  const problems = queues.filter((q) => q.stale || q.failed > 0);
  // P-17: Wartungsjobs melden, was nach ihrem Zeitbudget noch fällig ist.
  const withBacklog = queues.filter((q) => (q.backlog ?? 0) > 0);
  // B14: Rückstand über der Alarmschwelle (der Worker benachrichtigt bereits).
  const alarmed = queues.filter((q) => q.backlogStatus?.alarm);
  const threshold = alarmed[0]?.backlogStatus?.threshold;

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-primary mb-1">System → Jobs</h1>
        <p className="text-muted text-sm max-w-3xl">
          Verarbeitungsstatus der Hintergrund-Jobs (BullMQ). „Veraltet" = der letzte erfolgreiche
          Lauf liegt außerhalb des zum tatsächlichen Zeitplan gehörenden Karenzfensters — ein
          Hinweis auf einen ausgefallenen periodischen Job. Fehlgeschlagene Jobs (`failed`) sollten
          geprüft werden; die letzte Fehlermeldung steht rechts. „Rückstand" = was der letzte
          erfolgreiche Lauf eines Wartungsjobs als weiterhin fällig gemeldet hat (audit-rotate:
          Audit-Einträge, storage-orphan-cleanup: Storage-Kandidaten), samt Fälligkeit des ältesten
          offenen Eintrags. „Alarm" = der Rückstand hat die Alarmschwelle erreicht.
        </p>
      </div>

      {problems.length > 0 && (
        <div className="alert-warning mb-4 text-sm">
          <strong>{problems.length}</strong> Queue(s) mit veraltetem Lauf oder Fehlern — siehe rot
          markierte Zeilen.
        </div>
      )}

      {alarmed.length > 0 && threshold && (
        <div className="alert-warning mb-4 text-sm">
          <strong>{alarmed.length}</strong> Wartungsjob(s) über der Alarmschwelle (
          {describeBacklogThreshold(threshold)}). Admins und Partner der betroffenen Kanzleien
          erhalten einen Hinweis, die Betriebsadresse (OPS_ALERT_EMAIL, falls gesetzt) höchstens
          eine Mail je Tag. Bitte die Worker-Logs prüfen.
        </div>
      )}

      {withBacklog.length > 0 && (
        <div className="alert-info mb-4 text-sm">
          <strong>{withBacklog.length}</strong> Wartungsjob(s) mit Rückstand: der letzte Lauf hat
          sein Zeitbudget ausgeschöpft oder Einträge nicht auflösen können. Der nächste Lauf
          arbeitet weiter; wächst der Rückstand von Lauf zu Lauf, bitte die Worker-Logs prüfen.
        </div>
      )}

      <div className="card overflow-hidden">
        <div
          className="overflow-x-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-600"
          role="region"
          aria-label="Status der Hintergrund-Jobs: Tabelle"
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Tastaturzugriff auf horizontal scrollbare Tabellenspalten.
          tabIndex={0}
        >
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-default">
                <th className="th">Queue</th>
                <th className="th th-right">Wartend</th>
                <th className="th th-right">Aktiv</th>
                <th className="th th-right">Fehlgeschlagen</th>
                <th className="th th-right">Rückstand</th>
                <th className="th">Letzter Erfolg</th>
                <th className="th">Letzter Fehler</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {queues.map((q) => {
                const problem = q.stale || q.failed > 0;
                return (
                  <tr
                    key={q.name}
                    className={problem ? 'bg-red-50/50 dark:bg-red-950/30' : 'hover:bg-gray-50'}
                  >
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
                    <BacklogCell queue={q} />
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
