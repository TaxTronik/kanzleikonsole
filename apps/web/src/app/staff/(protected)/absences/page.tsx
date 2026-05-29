import { redirect } from 'next/navigation';
import { Plane, Thermometer, Check, X } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { VacationForm } from './vacation-form';
import { SickForm } from './sick-form';
import { decideVacationAction, cancelVacationAction } from './actions';
import { fmtDateShort } from '@/lib/fmt';

const statusLabels: Record<string, string> = {
  PENDING: 'Ausstehend',
  APPROVED: 'Genehmigt',
  REJECTED: 'Abgelehnt',
  CANCELLED: 'Zurückgezogen',
};

export default async function AbsencesPage() {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');

  const { tenantId, staffId, roles } = session.user;
  const isAdmin = roles?.includes('ADMIN') || roles?.includes('PARTNER');

  const [myVacations, allPendingVacations, mySick, staff] = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) =>
      Promise.all([
        tx.vacationRequest.findMany({
          where: { staffId },
          orderBy: { startDate: 'desc' },
          take: 30,
        }),
        isAdmin
          ? tx.vacationRequest.findMany({
              where: { status: 'PENDING' },
              orderBy: { startDate: 'asc' },
              include: { staff: { select: { fullName: true } } },
              take: 30,
            })
          : Promise.resolve([]),
        tx.sickLeave.findMany({
          where: { staffId },
          orderBy: { startDate: 'desc' },
          take: 30,
        }),
        tx.staffUser.findMany({
          where: { active: true },
          select: { id: true, fullName: true },
        }),
      ]),
  );

  const staffById = new Map(staff.map((s) => [s.id, s.fullName]));

  return (
    <div className="p-8">
      <div className="flex items-end justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-primary mb-1">Abwesenheiten</h1>
          <p className="text-muted text-sm">
            Urlaub beantragen oder Krankheit melden.
          </p>
        </div>
        <a href="/staff/absences/calendar" className="btn-secondary text-xs">
          Wandkalender
        </a>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Urlaub */}
        <div className="card p-6 h-fit">
          <h2 className="text-sm font-medium text-primary mb-3 flex items-center gap-2">
            <Plane className="h-4 w-4 text-brand-600" />
            Urlaub beantragen
          </h2>
          <VacationForm />
        </div>

        {/* Krankmeldung */}
        <div className="card p-6 h-fit">
          <h2 className="text-sm font-medium text-primary mb-3 flex items-center gap-2">
            <Thermometer className="h-4 w-4 text-red-600" />
            Krankmeldung
          </h2>
          <SickForm />
        </div>
      </div>

      {/* Admin: ausstehende Anträge */}
      {isAdmin && allPendingVacations.length > 0 && (
        <div className="card overflow-hidden mb-6 border-yellow-200">
          <div className="px-6 py-4 border-b border-default bg-yellow-50">
            <h2 className="text-sm font-medium text-yellow-900">
              {allPendingVacations.length} Urlaubsanträge zur Entscheidung
            </h2>
          </div>
          <ul className="divide-y divide-border-subtle">
            {allPendingVacations.map((v) => (
              <li key={v.id} className="px-6 py-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-primary">{v.staff.fullName}</p>
                    <p className="text-xs text-muted">
                      {fmtDateShort(v.startDate)}
                      {' – '}
                      {fmtDateShort(v.endDate)}
                      {' · '}
                      {v.workdays} Werktage
                    </p>
                    {v.reason && (
                      <p className="text-sm text-secondary mt-1">{v.reason}</p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <form action={decideVacationAction}>
                      <input type="hidden" name="requestId" value={v.id} />
                      <input type="hidden" name="approve" value="1" />
                      <button type="submit" className="btn-primary text-xs py-1.5">
                        <Check className="h-3.5 w-3.5" />
                        Genehmigen
                      </button>
                    </form>
                    <form action={decideVacationAction}>
                      <input type="hidden" name="requestId" value={v.id} />
                      <button
                        type="submit"
                        className="btn-secondary text-xs py-1.5 text-red-700 border-red-300 hover:bg-red-50"
                      >
                        <X className="h-3.5 w-3.5" />
                        Ablehnen
                      </button>
                    </form>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Eigene Urlaubsanträge */}
      <div className="card overflow-hidden mb-6">
        <div className="px-6 py-4 border-b border-default">
          <h2 className="text-sm font-medium text-primary">Meine Urlaubsanträge</h2>
        </div>
        {myVacations.length === 0 ? (
          <p className="px-6 py-10 text-sm text-disabled text-center">Noch keine Anträge.</p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {myVacations.map((v) => (
              <li key={v.id} className="px-6 py-3 flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-primary">
                      {fmtDateShort(v.startDate)}
                      {' – '}
                      {fmtDateShort(v.endDate)}
                    </span>
                    {v.status === 'PENDING' && <span className="badge-yellow">{statusLabels[v.status]}</span>}
                    {v.status === 'APPROVED' && <span className="badge-green">{statusLabels[v.status]}</span>}
                    {v.status === 'REJECTED' && <span className="badge-red">{statusLabels[v.status]}</span>}
                    {v.status === 'CANCELLED' && <span className="badge-gray">{statusLabels[v.status]}</span>}
                  </div>
                  <p className="text-xs text-muted">
                    {v.workdays} Werktage
                    {v.decidedBy && staffById.get(v.decidedBy) ? ` · entschieden von ${staffById.get(v.decidedBy)}` : ''}
                    {v.decisionNote ? ` · ${v.decisionNote}` : ''}
                  </p>
                </div>
                {v.status === 'PENDING' && (
                  <form action={cancelVacationAction}>
                    <input type="hidden" name="requestId" value={v.id} />
                    <button type="submit" className="btn-secondary text-xs py-1">
                      Zurückziehen
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Eigene Krankmeldungen */}
      <div className="card overflow-hidden">
        <div className="px-6 py-4 border-b border-default">
          <h2 className="text-sm font-medium text-primary">Meine Krankmeldungen</h2>
        </div>
        {mySick.length === 0 ? (
          <p className="px-6 py-10 text-sm text-disabled text-center">Keine Einträge.</p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {mySick.map((s) => (
              <li key={s.id} className="px-6 py-3">
                <p className="text-sm text-primary">
                  {fmtDateShort(s.startDate)}
                  {s.endDate ? ` – ${fmtDateShort(s.endDate)}` : ' (offen)'}
                </p>
                {s.notes && <p className="text-xs text-muted mt-1">{s.notes}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
