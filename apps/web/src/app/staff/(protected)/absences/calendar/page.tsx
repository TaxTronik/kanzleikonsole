// =============================================================================
// /staff/absences/calendar — Wandkalender für Urlaub + Krankheit
//
// Pro Mitarbeiter eine Zeile, pro Tag eine Zelle. Genehmigte Urlaubstage und
// Krankheitstage werden farblich markiert. Default 8 Wochen voraus, via
// ?weeks=4|8|12 anpassbar. Kein Vergleich/Quoten/Auswertung — nur
// Sichtbarkeit zur Absprache.
// =============================================================================

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Plane } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { fmtDateMedium, fmtWeekdayShort } from '@/lib/fmt';

const dayFmt = new Intl.DateTimeFormat('de-DE', { day: '2-digit' });
const monthFmt = new Intl.DateTimeFormat('de-DE', { month: 'short' });

function startOfDayUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function isWeekend(d: Date): boolean {
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

export default async function AbsencesCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ weeks?: string }>;
}) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  const sp = await searchParams;
  const weeks = Math.min(Math.max(Number(sp.weeks ?? '8'), 2), 26);
  const totalDays = weeks * 7;

  const { tenantId, staffId } = session.user;

  // Start: Montag der aktuellen Woche
  const today = startOfDayUTC(new Date());
  const dayOfWeek = (today.getUTCDay() + 6) % 7; // 0=Mo
  const start = new Date(today.getTime() - dayOfWeek * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + (totalDays - 1) * 24 * 60 * 60 * 1000);

  const data = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) =>
      Promise.all([
        tx.staffUser.findMany({
          where: { active: true },
          orderBy: { fullName: 'asc' },
          select: { id: true, fullName: true },
        }),
        tx.vacationRequest.findMany({
          where: {
            status: 'APPROVED',
            startDate: { lte: end },
            endDate: { gte: start },
          },
          select: { staffId: true, startDate: true, endDate: true },
        }),
        tx.sickLeave.findMany({
          where: {
            startDate: { lte: end },
            OR: [{ endDate: null }, { endDate: { gte: start } }],
          },
          select: { staffId: true, startDate: true, endDate: true },
        }),
      ]),
  );
  const [staffList, vacations, sickLeaves] = data;

  // Tag-Index → "U" oder "K" pro Mitarbeiter
  const cellMap = new Map<string, 'U' | 'K' | 'UK'>();
  function setCell(staffId: string, date: Date, kind: 'U' | 'K') {
    const key = `${staffId}:${date.toISOString().slice(0, 10)}`;
    const old = cellMap.get(key);
    if (!old) cellMap.set(key, kind);
    else if (old !== kind) cellMap.set(key, 'UK');
  }
  for (const v of vacations) {
    const s = startOfDayUTC(v.startDate);
    const e = startOfDayUTC(v.endDate);
    for (let d = s; d.getTime() <= e.getTime(); d = new Date(d.getTime() + 86400000)) {
      setCell(v.staffId, d, 'U');
    }
  }
  for (const sl of sickLeaves) {
    const s = startOfDayUTC(sl.startDate);
    const e = sl.endDate ? startOfDayUTC(sl.endDate) : end;
    for (let d = s; d.getTime() <= e.getTime(); d = new Date(d.getTime() + 86400000)) {
      setCell(sl.staffId, d, 'K');
    }
  }

  const days: Date[] = [];
  for (let i = 0; i < totalDays; i++) {
    days.push(new Date(start.getTime() + i * 86400000));
  }

  // Monatswechsel-Marker für Header
  const monthBoundaries = days.map((d, i) => {
    if (i === 0) return true;
    return d.getUTCMonth() !== days[i - 1]!.getUTCMonth();
  });

  return (
    <div className="p-8 max-w-full">
      <div className="flex items-end justify-between mb-6">
        <div>
          <h1 className="page-title">
            <Plane className="h-6 w-6 text-brand-600" />
            Abwesenheits-Kalender
          </h1>
          <p className="text-muted text-sm">
            {fmtDateMedium(start)} – {fmtDateMedium(end)} · alle Mitarbeiter
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="toggle-group">
            {[4, 8, 12].map((w) => (
              <Link
                key={w}
                href={`/staff/absences/calendar?weeks=${w}`}
                className={
                  w === weeks
                    ? 'px-3 py-1.5 bg-brand-600 text-white'
                    : 'px-3 py-1.5 text-secondary hover:bg-gray-50'
                }
              >
                {w} Wochen
              </Link>
            ))}
          </div>
          <Link href="/staff/absences" className="btn-secondary text-xs">
            Anträge
          </Link>
        </div>
      </div>

      <div className="card overflow-x-auto">
        <table className="text-xs border-separate border-spacing-0">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-surface border-b border-r border-default px-3 py-2 text-left text-xs font-medium text-muted uppercase">
                Mitarbeiter
              </th>
              {days.map((d, i) => (
                <th
                  key={i}
                  className={
                    'border-b border-default w-7 min-w-[28px] text-center font-normal ' +
                    (monthBoundaries[i] ? 'border-l-2 border-l-gray-300' : '')
                  }
                >
                  <div className="text-[10px] text-disabled leading-none pt-1">
                    {monthBoundaries[i] ? monthFmt.format(d) : ''}
                  </div>
                  <div className="text-[10px] text-muted leading-none">{fmtWeekdayShort(d).slice(0, 2)}</div>
                  <div className={isWeekend(d) ? 'text-disabled' : 'text-secondary'}>{dayFmt.format(d)}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {staffList.map((s) => (
              <tr key={s.id}>
                <td className="sticky left-0 z-10 bg-surface border-r border-subtle px-3 py-1 text-sm whitespace-nowrap">
                  {s.fullName}
                </td>
                {days.map((d, i) => {
                  const key = `${s.id}:${d.toISOString().slice(0, 10)}`;
                  const cell = cellMap.get(key);
                  const weekend = isWeekend(d);
                  const cls = cell === 'U'
                    ? 'bg-emerald-200'
                    : cell === 'K'
                      ? 'bg-red-200'
                      : cell === 'UK'
                        ? 'bg-amber-300'
                        : weekend
                          ? 'bg-gray-50'
                          : '';
                  const title = cell === 'U' ? 'Urlaub' : cell === 'K' ? 'Krank' : cell === 'UK' ? 'Urlaub+Krank' : '';
                  return (
                    <td
                      key={i}
                      className={
                        'border-b border-subtle h-6 text-center ' +
                        cls +
                        (monthBoundaries[i] ? ' border-l-2 border-l-gray-300' : '')
                      }
                      title={title ? `${s.fullName} · ${fmtDateMedium(d)} · ${title}` : ''}
                    >
                      {cell === 'U' && <span className="text-[10px] text-emerald-900 font-medium">U</span>}
                      {cell === 'K' && <span className="text-[10px] text-red-900 font-medium">K</span>}
                      {cell === 'UK' && <span className="text-[10px] text-amber-900 font-medium">UK</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-center gap-4 text-xs text-secondary">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded bg-emerald-200" /> Urlaub (genehmigt)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded bg-red-200" /> Krank
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded bg-gray-50 border border-default" /> Wochenende
        </span>
      </div>
    </div>
  );
}
