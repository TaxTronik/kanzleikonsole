// =============================================================================
// /staff/tax-deadlines/group?kind=...&period=... — Mandanten-Liste pro Termin
//
// Zeigt für eine konkrete (kind, period)-Gruppe alle Mandanten und ob sie
// erledigt / in Bearbeitung / offen / überfällig sind. Quick-Action: einzelne
// Termine als erledigt markieren oder Auto-Anforderung öffnen.
// =============================================================================

import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, CalendarDays } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import type { Prisma, TaxScheduleKind } from '@prisma/client';
import { SCHEDULE_LABELS } from '@taxtronik/tax';
import { markDeadlineDoneAction } from '../actions';

const STATUS_LABELS: Record<string, string> = {
  PLANNED: 'Geplant',
  REMINDED: 'Erinnerung',
  IN_PROGRESS: 'In Bearbeitung',
  SUBMITTED: 'Übermittelt',
  DONE: 'Erledigt',
  OVERDUE: 'Überfällig',
  SKIPPED: 'Übersprungen',
};

const VALID_KINDS: TaxScheduleKind[] = [
  'USTA_MONATLICH', 'USTA_QUARTAL', 'USTA_JAEHRLICH',
  'LSTA_MONATLICH', 'LSTA_QUARTAL', 'LSTA_JAEHRLICH',
  'EST_VZ', 'KST_VZ', 'GEWST_VZ',
  'EST_ERKLAERUNG', 'KST_ERKLAERUNG', 'GEWST_ERKLAERUNG',
];

const dateFmt = new Intl.DateTimeFormat('de-DE');

export default async function TaxDeadlineGroupPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; period?: string; scope?: string }>;
}) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  const sp = await searchParams;

  if (!sp.kind || !sp.period) notFound();
  if (!(VALID_KINDS as readonly string[]).includes(sp.kind)) notFound();
  const kind = sp.kind as TaxScheduleKind;
  const period = sp.period;
  const scope = sp.scope === 'mine' ? 'mine' : 'all';

  const { tenantId, staffId } = session.user;

  const where: Prisma.TaxDeadlineWhereInput = { kind, period };
  if (scope === 'mine') {
    where.client = { responsibilities: { some: { staffId } } };
  }

  const deadlines = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) =>
      tx.taxDeadline.findMany({
        where,
        orderBy: [{ status: 'asc' }, { client: { name: 'asc' } }],
        include: { client: { select: { id: true, name: true } } },
      }),
  );

  // Aufteilen
  const groups: Record<string, typeof deadlines> = {
    OVERDUE: [],
    OPEN: [],
    DONE: [],
  };
  for (const d of deadlines) {
    if (d.status === 'OVERDUE') groups['OVERDUE']!.push(d);
    else if (d.status === 'DONE' || d.status === 'SKIPPED') groups['DONE']!.push(d);
    else groups['OPEN']!.push(d);
  }

  const dueDate = deadlines[0]?.dueDate;

  return (
    <div className="p-8 max-w-5xl">
      <Link
        href={`/staff/tax-deadlines?scope=${scope}`}
        className="text-sm text-gray-500 hover:text-gray-900 inline-flex items-center gap-1 mb-4"
      >
        <ArrowLeft className="h-4 w-4" /> Zurück zum Kalender
      </Link>

      <div className="flex items-end justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 mb-1 flex items-center gap-2">
            <CalendarDays className="h-6 w-6 text-brand-600" />
            {SCHEDULE_LABELS[kind]}
          </h1>
          <p className="text-gray-500 text-sm">
            Periode {period}
            {dueDate && ` · fällig am ${dateFmt.format(dueDate)}`}
            {' · '}
            {deadlines.length} Mandanten
          </p>
        </div>
      </div>

      {groups['OVERDUE']!.length > 0 && (
        <Section title="Überfällig" rows={groups['OVERDUE']!} accent="red" />
      )}
      <Section title="Offen / In Bearbeitung" rows={groups['OPEN']!} />
      {groups['DONE']!.length > 0 && (
        <Section title="Erledigt" rows={groups['DONE']!} accent="emerald" />
      )}
    </div>
  );
}

function Section({
  title, rows, accent,
}: {
  title: string;
  rows: Array<{
    id: string;
    status: string;
    requestId: string | null;
    completedAt: Date | null;
    client: { id: string; name: string };
  }>;
  accent?: 'red' | 'emerald';
}) {
  if (rows.length === 0) {
    return (
      <section className="mb-6">
        <h2 className={`text-sm font-semibold mb-3 ${accent === 'red' ? 'text-red-700' : accent === 'emerald' ? 'text-emerald-700' : 'text-gray-900'}`}>
          {title} <span className="text-gray-400 font-normal">(0)</span>
        </h2>
        <div className="card p-6 text-center text-sm text-gray-400">Keine Einträge.</div>
      </section>
    );
  }
  return (
    <section className="mb-6">
      <h2 className={`text-sm font-semibold mb-3 ${accent === 'red' ? 'text-red-700' : accent === 'emerald' ? 'text-emerald-700' : 'text-gray-900'}`}>
        {title} <span className="text-gray-400 font-normal">({rows.length})</span>
      </h2>
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <tbody className="divide-y divide-gray-100">
            {rows.map((d) => (
              <tr key={d.id} className="hover:bg-gray-50">
                <td className="px-6 py-3">
                  <Link href={`/staff/clients/${d.client.id}`} className="text-gray-900 font-medium hover:underline">
                    {d.client.name}
                  </Link>
                </td>
                <td className="px-6 py-3">
                  {d.status === 'OVERDUE' && <span className="badge-red">{STATUS_LABELS[d.status]}</span>}
                  {d.status === 'REMINDED' && <span className="badge-yellow">{STATUS_LABELS[d.status]}</span>}
                  {d.status === 'PLANNED' && <span className="badge-gray">{STATUS_LABELS[d.status]}</span>}
                  {d.status === 'IN_PROGRESS' && <span className="badge-yellow">{STATUS_LABELS[d.status]}</span>}
                  {d.status === 'SUBMITTED' && <span className="badge-green">{STATUS_LABELS[d.status]}</span>}
                  {d.status === 'DONE' && <span className="badge-green">{STATUS_LABELS[d.status]}</span>}
                  {d.status === 'SKIPPED' && <span className="badge-gray">{STATUS_LABELS[d.status]}</span>}
                </td>
                <td className="px-6 py-3 text-xs text-gray-500">
                  {d.completedAt ? `am ${dateFmt.format(d.completedAt)}` : ''}
                </td>
                <td className="px-6 py-3 text-right">
                  <div className="flex items-center justify-end gap-2">
                    {d.requestId && (
                      <Link href={`/staff/requests/${d.requestId}`} className="text-xs text-brand-700 hover:underline">
                        Anforderung
                      </Link>
                    )}
                    {d.status !== 'DONE' && d.status !== 'SKIPPED' && (
                      <form action={markDeadlineDoneAction} className="inline">
                        <input type="hidden" name="id" value={d.id} />
                        <button type="submit" className="text-xs text-gray-500 hover:text-emerald-700">
                          ✓ Erledigt
                        </button>
                      </form>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
