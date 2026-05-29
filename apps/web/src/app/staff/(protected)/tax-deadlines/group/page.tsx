// =============================================================================
// /staff/tax-deadlines/group?kind=...&period=... — Mandanten-Liste pro Termin
//
// Zeigt für eine konkrete (kind, period)-Gruppe alle Mandanten und ob sie
// erledigt / in Bearbeitung / offen / überfällig sind. Quick-Action: einzelne
// Termine als erledigt markieren oder Auto-Anforderung öffnen.
// =============================================================================

import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, CalendarDays, CheckCheck } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import type { Prisma, TaxScheduleKind } from '@prisma/client';
import { SCHEDULE_LABELS } from '@taxtronik/tax';
import { markDeadlineDoneAction, markDeadlinesDoneAction } from '../actions';
import { fmtDateShort } from '@/lib/fmt';

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


export default async function TaxDeadlineGroupPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; period?: string; scope?: string; q?: string }>;
}) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  const sp = await searchParams;

  if (!sp.kind || !sp.period) notFound();
  if (!(VALID_KINDS as readonly string[]).includes(sp.kind)) notFound();
  const kind = sp.kind as TaxScheduleKind;
  const period = sp.period;
  const scope = sp.scope === 'mine' ? 'mine' : 'all';
  const q = (sp.q ?? '').trim();

  const { tenantId, staffId } = session.user;

  // Client-Filter aufbauen: scope + Volltext-Suche kombinierbar.
  const clientWhere: Prisma.ClientWhereInput = {};
  if (scope === 'mine') {
    clientWhere.responsibilities = { some: { staffId } };
  }
  if (q) {
    clientWhere.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { datevNo: { contains: q, mode: 'insensitive' } },
      { addisonNo: { contains: q, mode: 'insensitive' } },
    ];
  }
  const where: Prisma.TaxDeadlineWhereInput = { kind, period };
  if (Object.keys(clientWhere).length > 0) {
    where.client = clientWhere;
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
        className="back-link"
      >
        <ArrowLeft className="h-4 w-4" /> Zurück zum Kalender
      </Link>

      <div className="mb-6">
        <div className="flex items-end justify-between mb-3">
          <div>
            <h1 className="page-title">
              <CalendarDays className="h-6 w-6 text-brand-600" />
              {SCHEDULE_LABELS[kind]}
            </h1>
            <p className="text-muted text-sm">
              Periode {period}
              {dueDate && ` · fällig am ${fmtDateShort(dueDate)}`}
              {' · '}
              {deadlines.length} Mandanten
              {q && <span> · Suche: <strong className="text-primary">{q}</strong></span>}
            </p>
          </div>
        </div>
        <form
          method="get"
          action="/staff/tax-deadlines/group"
          className="flex items-center gap-2"
        >
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="period" value={period} />
          <input type="hidden" name="scope" value={scope} />
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Mandant in dieser Gruppe filtern — Name, DATEV-Nr. oder Addison-Nr."
            className="input flex-1 text-sm"
            maxLength={120}
          />
          <button type="submit" className="btn-secondary text-xs">Filtern</button>
          {q && (
            <Link
              href={`/staff/tax-deadlines/group?kind=${kind}&period=${encodeURIComponent(period)}&scope=${scope}`}
              className="btn-secondary text-xs"
            >
              Zurücksetzen
            </Link>
          )}
        </form>
      </div>

      <form action={markDeadlinesDoneAction}>
        {groups['OVERDUE']!.length + groups['OPEN']!.length > 0 && (
          <div className="flex items-center justify-end mb-3">
            <button type="submit" className="btn-secondary text-xs">
              <CheckCheck className="h-4 w-4" />
              Ausgewählte als erledigt markieren
            </button>
          </div>
        )}
        {groups['OVERDUE']!.length > 0 && (
          <Section title="Überfällig" rows={groups['OVERDUE']!} accent="red" selectable />
        )}
        <Section title="Offen / In Bearbeitung" rows={groups['OPEN']!} selectable />
      </form>
      {groups['DONE']!.length > 0 && (
        <Section title="Erledigt" rows={groups['DONE']!} accent="emerald" />
      )}
    </div>
  );
}

function Section({
  title, rows, accent, selectable,
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
  selectable?: boolean;
}) {
  if (rows.length === 0) {
    return (
      <section className="mb-6">
        <h2 className={`text-sm font-semibold mb-3 ${accent === 'red' ? 'text-red-700' : accent === 'emerald' ? 'text-emerald-700' : 'text-primary'}`}>
          {title} <span className="text-disabled font-normal">(0)</span>
        </h2>
        <div className="card p-6 text-center text-sm text-disabled">Keine Einträge.</div>
      </section>
    );
  }
  return (
    <section className="mb-6">
      <h2 className={`text-sm font-semibold mb-3 ${accent === 'red' ? 'text-red-700' : accent === 'emerald' ? 'text-emerald-700' : 'text-primary'}`}>
        {title} <span className="text-disabled font-normal">({rows.length})</span>
      </h2>
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <tbody className="divide-y divide-border-subtle">
            {rows.map((d) => (
              <tr key={d.id} className="hover:bg-gray-50">
                {selectable && (
                  <td className="pl-6 py-3 w-8">
                    <input
                      type="checkbox"
                      name="ids"
                      value={d.id}
                      aria-label={`${d.client.name} auswählen`}
                      className="h-4 w-4 rounded border-default text-brand-600 focus:ring-brand-500"
                    />
                  </td>
                )}
                <td className="px-6 py-3">
                  <Link href={`/staff/clients/${d.client.id}`} className="text-primary font-medium hover:underline">
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
                <td className="px-6 py-3 text-xs text-muted">
                  {d.completedAt ? `am ${fmtDateShort(d.completedAt)}` : ''}
                </td>
                <td className="px-6 py-3 text-right">
                  <div className="flex items-center justify-end gap-2">
                    {d.requestId && (
                      <Link href={`/staff/requests/${d.requestId}`} className="text-xs text-brand-700 hover:underline">
                        Anforderung
                      </Link>
                    )}
                    {!selectable && d.status !== 'DONE' && d.status !== 'SKIPPED' && (
                      <form action={markDeadlineDoneAction} className="inline">
                        <input type="hidden" name="id" value={d.id} />
                        <button type="submit" className="text-xs text-muted hover:text-emerald-700">
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
