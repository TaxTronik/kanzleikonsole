import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Plane, CalendarOff, Check, X, Inbox, UserCheck } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { hasStaffPermission } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { VacationForm } from './vacation-form';
import { AbsenceForm } from './absence-form';
import { decideVacationAction, cancelVacationAction, endAbsenceAction, deleteAbsenceAction } from './actions';
import { loadAbsenceCoverage } from '@/server/absences/coverage';
import { fmtDateShort } from '@/lib/fmt';

const statusLabels: Record<string, string> = {
  PENDING: 'Ausstehend',
  APPROVED: 'Genehmigt',
  REJECTED: 'Abgelehnt',
  CANCELLED: 'Zurückgezogen',
};

const kindLabels: Record<string, string> = {
  SICKNESS: 'Krankheit',
  OTHER: 'Sonstige',
};

export default async function AbsencesPage() {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');

  const { tenantId, staffId } = session.user;
  // iter87: Entscheiden + Meldungen einsehen via Einzelrecht (Admin/Partner implizit).
  const canDecide = hasStaffPermission(session, 'ABSENCE_DECIDE');

  const today = new Date();
  const recentWindow = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);

  const { myVacations, allPendingVacations, myAbsences, teamAbsences, staff, coverage } = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const [myVacations, allPendingVacations, myAbsences, teamAbsences, staff] = await Promise.all([
        tx.vacationRequest.findMany({
          where: { staffId },
          orderBy: { startDate: 'desc' },
          take: 30,
        }),
        canDecide
          ? tx.vacationRequest.findMany({
              where: { status: 'PENDING' },
              orderBy: { startDate: 'asc' },
              include: { staff: { select: { fullName: true } } },
              take: 30,
            })
          : Promise.resolve([]),
        tx.absence.findMany({
          where: { staffId },
          orderBy: { startDate: 'desc' },
          take: 30,
        }),
        // Grund/Art sind vertraulich: Team-Meldungen sieht NUR, wer
        // entscheiden darf — alle anderen sehen im Kalender nur „abw.".
        canDecide
          ? tx.absence.findMany({
              where: {
                staffId: { not: staffId },
                OR: [{ endDate: null }, { endDate: { gte: recentWindow } }],
              },
              orderBy: { startDate: 'desc' },
              include: { staff: { select: { fullName: true } } },
              take: 30,
            })
          : Promise.resolve([]),
        tx.staffUser.findMany({
          where: { active: true },
          select: { id: true, fullName: true },
        }),
      ]);
      const coverage = await loadAbsenceCoverage(tx, staffId);
      return { myVacations, allPendingVacations, myAbsences, teamAbsences, staff, coverage };
    },
  );

  const staffById = new Map(staff.map((s) => [s.id, s.fullName]));

  return (
    <div className="p-8">
      <div className="flex items-end justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-primary mb-1">Abwesenheiten</h1>
          <p className="text-muted text-sm">
            Urlaub beantragen oder Abwesenheit melden (Krankheit, Fortbildung …).
          </p>
        </div>
        <a href="/staff/absences/calendar" className="btn-secondary text-xs">
          Wandkalender
        </a>
      </div>

      {/* Vertretung: heute abwesende Kolleg:innen + deren offene Vorgänge */}
      {coverage.length > 0 && (
        <div className="card overflow-hidden mb-6">
          <div className="px-6 py-4 border-b border-default flex items-center gap-2">
            <UserCheck className="h-4 w-4 text-brand-600" />
            <h2 className="text-sm font-medium text-primary">Vertretung — heute abwesend</h2>
          </div>
          <ul className="divide-y divide-border-subtle">
            {coverage.map((c) => (
              <li key={c.staffId} className="px-6 py-4">
                <div className="flex items-center justify-between gap-3 mb-2">
                  <p className="font-medium text-primary">
                    {c.fullName}
                    <span className="ml-2 text-xs font-normal text-muted">
                      {c.kind === 'vacation' ? 'Urlaub' : 'abw.'}
                      {c.until ? ` bis ${fmtDateShort(c.until)}` : ''}
                    </span>
                  </p>
                  <span className="inline-flex items-center gap-1 text-xs text-muted">
                    <Inbox className="h-3.5 w-3.5" />
                    {c.requests.length} offen
                  </span>
                </div>
                {c.requests.length === 0 ? (
                  <p className="text-xs text-disabled">Keine offenen Anforderungen bei betreuten Mandanten.</p>
                ) : (
                  <ul className="space-y-1">
                    {c.requests.slice(0, 8).map((r) => (
                      <li key={r.id} className="text-sm flex items-center justify-between gap-3">
                        <Link href={`/staff/requests/${r.id}`} className="text-secondary hover:text-primary hover:underline truncate">
                          {r.title} <span className="text-muted">· {r.clientName}</span>
                        </Link>
                        {r.dueAt && <span className="text-xs text-muted shrink-0">fällig {fmtDateShort(r.dueAt)}</span>}
                      </li>
                    ))}
                    {c.requests.length > 8 && (
                      <li className="text-xs text-disabled">+ {c.requests.length - 8} weitere</li>
                    )}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Urlaub */}
        <div className="card p-6 h-fit">
          <h2 className="text-sm font-medium text-primary mb-3 flex items-center gap-2">
            <Plane className="h-4 w-4 text-brand-600" />
            Urlaub beantragen
          </h2>
          <VacationForm />
        </div>

        {/* Abwesenheitsmeldung (krank/sonstige) */}
        <div className="card p-6 h-fit">
          <h2 className="text-sm font-medium text-primary mb-3 flex items-center gap-2">
            <CalendarOff className="h-4 w-4 text-red-600" />
            Abwesenheit melden
          </h2>
          <AbsenceForm />
        </div>
      </div>

      {/* Entscheidungsträger: ausstehende Anträge */}
      {canDecide && allPendingVacations.length > 0 && (
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

      {/* Eigene Abwesenheitsmeldungen */}
      <div className="card overflow-hidden mb-6">
        <div className="px-6 py-4 border-b border-default">
          <h2 className="text-sm font-medium text-primary">Meine Abwesenheitsmeldungen</h2>
        </div>
        {myAbsences.length === 0 ? (
          <p className="px-6 py-10 text-sm text-disabled text-center">Keine Einträge.</p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {myAbsences.map((s) => (
              <li key={s.id} className="px-6 py-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-primary">
                    {fmtDateShort(s.startDate)}
                    {s.endDate ? ` – ${fmtDateShort(s.endDate)}` : ' (offen)'}
                    <span className="ml-2 text-xs text-muted">{kindLabels[s.kind] ?? s.kind}</span>
                  </p>
                  {s.notes && <p className="text-xs text-muted mt-1">{s.notes}</p>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {!s.endDate && (
                    <form action={endAbsenceAction}>
                      <input type="hidden" name="id" value={s.id} />
                      <button type="submit" className="text-xs text-brand-700 hover:underline">Beenden</button>
                    </form>
                  )}
                  <form action={deleteAbsenceAction}>
                    <input type="hidden" name="id" value={s.id} />
                    <button type="submit" className="text-xs text-red-700 hover:underline">Löschen</button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Entscheidungsträger: Meldungen des Teams (Art + Grund sichtbar) */}
      {canDecide && teamAbsences.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-default">
            <h2 className="text-sm font-medium text-primary">Meldungen im Team (letzte 30 Tage)</h2>
            <p className="text-xs text-muted mt-0.5">
              Nur für Entscheidungsträger sichtbar — der Kalender zeigt allen anderen nur „abw.".
            </p>
          </div>
          <ul className="divide-y divide-border-subtle">
            {teamAbsences.map((s) => (
              <li key={s.id} className="px-6 py-3">
                <p className="text-sm text-primary">
                  <span className="font-medium">{s.staff.fullName}</span>
                  {' · '}
                  {fmtDateShort(s.startDate)}
                  {s.endDate ? ` – ${fmtDateShort(s.endDate)}` : ' (offen)'}
                  <span className="ml-2 text-xs text-muted">{kindLabels[s.kind] ?? s.kind}</span>
                </p>
                {s.notes && <p className="text-xs text-muted mt-1">{s.notes}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
