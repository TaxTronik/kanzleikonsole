import type { ReactNode } from 'react';
// =============================================================================
// Kalender-Widget — gemerged appointments + tax-deadlines, nächste 30 Tage.
// =============================================================================

import Link from 'next/link';
import { CalendarDays } from 'lucide-react';
import { SCHEDULE_LABELS } from '@taxtronik/tax';
import { fmtDateShort, fmtTimeShort } from '@/lib/fmt';
import { CALENDAR_PAST_MS } from '@/lib/consts';
import { ListShell, notDeniedClient, type RenderCtx } from './_shared';

export async function CalendarWidget({ tx, deniedClientIds }: RenderCtx): Promise<ReactNode> {
  const horizon = new Date();
  horizon.setDate(horizon.getDate() + 30);
  const [appts, deadlines] = await Promise.all([
    tx.appointment.findMany({
      where: {
        status: { not: 'CANCELLED' },
        endsAt: { gte: new Date() },
        startsAt: { lte: horizon },
        // clientId nullable: Termine ohne Mandantenbezug bleiben sichtbar.
        ...(deniedClientIds?.length
          ? { OR: [{ clientId: null }, { clientId: { notIn: deniedClientIds } }] }
          : {}),
      },
      orderBy: { startsAt: 'asc' },
      take: 20,
      select: {
        id: true,
        title: true,
        startsAt: true,
        endsAt: true,
        location: true,
        status: true,
        owner: { select: { fullName: true } },
        client: { select: { id: true, name: true } },
      },
    }),
    tx.taxDeadline.findMany({
      where: {
        status: { in: ['PLANNED', 'REMINDED', 'IN_PROGRESS', 'OVERDUE'] },
        dueDate: { gte: new Date(Date.now() - CALENDAR_PAST_MS), lte: horizon },
        ...notDeniedClient(deniedClientIds),
      },
      orderBy: { dueDate: 'asc' },
      take: 20,
      include: { client: { select: { id: true, name: true } } },
    }),
  ]);

  type Row =
    | {
        kind: 'appt';
        id: string;
        date: Date;
        endsAt: Date;
        title: string;
        clientName: string | null;
        clientId: string | null;
        owner: string;
        location: string | null;
        status: string;
      }
    | {
        kind: 'tax';
        id: string;
        date: Date;
        title: string;
        clientName: string;
        clientId: string;
        overdue: boolean;
      };

  const rows: Row[] = [];
  for (const a of appts as Array<{
    id: string;
    title: string;
    startsAt: Date;
    endsAt: Date;
    location: string | null;
    status: string;
    owner: { fullName: string };
    client: { id: string; name: string } | null;
  }>) {
    rows.push({
      kind: 'appt',
      id: a.id,
      date: a.startsAt,
      endsAt: a.endsAt,
      title: a.title,
      clientName: a.client?.name ?? null,
      clientId: a.client?.id ?? null,
      owner: a.owner.fullName,
      location: a.location,
      status: a.status,
    });
  }
  for (const d of deadlines as Array<{
    id: string;
    kind: keyof typeof SCHEDULE_LABELS;
    dueDate: Date;
    status: string;
    period: string;
    client: { id: string; name: string };
  }>) {
    rows.push({
      kind: 'tax',
      id: d.id,
      date: d.dueDate,
      title: `${SCHEDULE_LABELS[d.kind] ?? d.kind} ${d.period}`,
      clientName: d.client.name,
      clientId: d.client.id,
      overdue: d.status === 'OVERDUE',
    });
  }
  rows.sort((a, b) => a.date.getTime() - b.date.getTime());
  const limited = rows.slice(0, 25);

  return (
    <ListShell
      icon={CalendarDays}
      title="Kalender"
      isEmpty={limited.length === 0}
      emptyText="Keine anstehenden Termine in den nächsten 30 Tagen."
    >
      {limited.map((r) =>
        r.kind === 'appt' ? (
          <li key={`appt-${r.id}`} className="px-5 py-2.5">
            <Link
              href={r.clientId ? `/staff/clients/${r.clientId}` : '/staff/calendar'}
              className="block hover:bg-gray-50 -mx-5 px-5 -my-1 py-1 rounded"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="item-title inline-flex items-center gap-2">
                  {r.title}
                  {r.status === 'CONFIRMED' && (
                    <span className="badge-green text-[10px]">bestätigt</span>
                  )}
                </p>
                <span className="text-xs text-muted shrink-0">{fmtDateShort(r.date)}</span>
              </div>
              <p className="text-xs text-muted truncate">
                {fmtTimeShort(r.date)} – {fmtTimeShort(r.endsAt)}
                {r.clientName ? ` · ${r.clientName}` : ''}
                {' · '}
                {r.owner}
                {r.location ? ` · ${r.location}` : ''}
              </p>
            </Link>
          </li>
        ) : (
          <li key={`tax-${r.id}`} className="px-5 py-2.5">
            <Link
              href={`/staff/clients/${r.clientId}`}
              className="block hover:bg-gray-50 -mx-5 px-5 -my-1 py-1 rounded"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="item-title inline-flex items-center gap-2">
                  {r.title}
                  <span className="badge-purple text-[10px]">Steuertermin</span>
                </p>
                <span
                  className={
                    r.overdue
                      ? 'text-xs text-red-700 font-medium shrink-0'
                      : 'text-xs text-muted shrink-0'
                  }
                >
                  {fmtDateShort(r.date)}
                </span>
              </div>
              <p className="text-xs text-muted truncate">{r.clientName}</p>
            </Link>
          </li>
        ),
      )}
    </ListShell>
  );
}
