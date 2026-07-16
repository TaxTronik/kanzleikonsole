import { Clock, Trash2, Square } from 'lucide-react';
import { requireStaffPage } from '@/server/auth/staff-page';
import { withTenantContext } from '@taxtronik/db';
import { StartTimerForm } from './start-form';
import { stopTimerAction, deleteTimeEntryAction } from './actions';
import { fmtMinutes, fmtTimeShort } from '@/lib/fmt';
import { inaccessibleClientIdsFor } from '@/server/auth/rbac';
import { buildTimePageAccessFilters } from './access';

export default async function TimeTrackingPage() {
  const session = await requireStaffPage();

  const { tenantId, staffId } = session.user;

  const [running, todayEntries, clients] = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const deniedClientIds = await inaccessibleClientIdsFor(tx, session);
      const { timeEntryWhere, clientWhere } = buildTimePageAccessFilters(deniedClientIds);
      return Promise.all([
        tx.timeEntry.findFirst({
          where: { staffId, endedAt: null, ...timeEntryWhere },
        }),
        tx.timeEntry.findMany({
          where: { staffId, startedAt: { gte: startOfDay }, ...timeEntryWhere },
          orderBy: { startedAt: 'desc' },
        }),
        tx.client.findMany({
          where: clientWhere,
          orderBy: { name: 'asc' },
          take: 500,
          select: { id: true, name: true },
        }),
      ]);
    },
  );

  const clientNameById = new Map(clients.map((c) => [c.id, c.name]));

  const totalMinutesToday = todayEntries.reduce((sum, e) => {
    const end = e.endedAt ?? new Date();
    return sum + Math.max(0, Math.floor((end.getTime() - e.startedAt.getTime()) / 60000));
  }, 0);

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-primary mb-1">Zeiterfassung</h1>
        <p className="text-muted text-sm">Heute: {fmtMinutes(totalMinutesToday)}</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 card overflow-hidden">
          <div className="px-6 py-4 border-b border-default flex items-center gap-2">
            <Clock className="h-4 w-4 text-disabled" />
            <h2 className="text-sm font-medium text-primary">Heute</h2>
          </div>
          {todayEntries.length === 0 ? (
            <p className="px-6 py-10 text-sm text-disabled text-center">
              Noch keine Einträge heute.
            </p>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {todayEntries.map((e) => {
                const end = e.endedAt ?? new Date();
                const minutes = Math.max(
                  0,
                  Math.floor((end.getTime() - e.startedAt.getTime()) / 60000),
                );
                const isRunning = !e.endedAt;
                return (
                  <li key={e.id} className="px-6 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="item-title">{e.description}</p>
                          {isRunning && <span className="badge-yellow">Läuft</span>}
                          {!e.billable && <span className="badge-gray">nicht abrechenbar</span>}
                        </div>
                        <p className="text-xs text-muted">
                          {fmtTime(e.startedAt)}
                          {e.endedAt ? ` – ${fmtTime(e.endedAt)}` : ' – läuft'}
                          {e.clientId ? ` · ${clientNameById.get(e.clientId) ?? 'Mandant'}` : ''}
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-mono text-secondary tabular-nums">
                          {fmtMinutes(minutes)}
                        </span>
                        {!isRunning && (
                          <form action={deleteTimeEntryAction}>
                            <input type="hidden" name="id" value={e.id} />
                            <button
                              type="submit"
                              className="text-disabled hover:text-red-600 p-1"
                              title="Löschen"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </form>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="card p-6 h-fit">
          {running ? (
            <>
              <h2 className="text-sm font-medium text-primary mb-3">Läuft gerade</h2>
              <p className="text-sm text-secondary mb-1">{running.description}</p>
              <p className="text-xs text-muted mb-4">seit {fmtTime(running.startedAt)}</p>
              <form action={stopTimerAction}>
                <button type="submit" className="btn-primary w-full">
                  <Square className="h-3.5 w-3.5" />
                  Stoppen
                </button>
              </form>
            </>
          ) : (
            <>
              <h2 className="text-sm font-medium text-primary mb-3">Neuer Timer</h2>
              <StartTimerForm clients={clients} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function fmtTime(d: Date): string {
  return fmtTimeShort(d);
}
