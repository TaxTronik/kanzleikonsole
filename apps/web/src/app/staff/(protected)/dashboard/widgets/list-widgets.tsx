// =============================================================================
// Einfache Listen-Widgets fürs Dashboard.
//
// Alle bauen auf `ListShell` aus `_shared` auf und unterscheiden sich nur in
// ihrer Datenquelle plus dem Row-Rendering.
// =============================================================================

import Link from 'next/link';
import {
  Activity,
  CalendarDays,
  FileWarning,
  Phone,
  Plus,
  ShieldAlert,
} from 'lucide-react';
import { SCHEDULE_LABELS } from '@taxtronik/tax';
import { fmtDateShort, fmtDateTimeShort } from '@/lib/fmt';
import { actionLabel, resourceLabel } from '@/server/audit/labels';
import { PhoneNoteRow } from '../phone-note-check';
import { ListShell, NOTICE_KIND_LABELS, type RenderCtx } from './_shared';

// --- Recent Activity ----------------------------------------------------------

export async function RecentActivity({ tx }: RenderCtx): Promise<React.ReactNode> {
  const [items, total] = await Promise.all([
    tx.auditLog.findMany({
      orderBy: { occurredAt: 'desc' },
      take: 25,
      select: {
        id: true,
        occurredAt: true,
        action: true,
        actorType: true,
        actorId: true,
        resourceType: true,
      },
    }),
    tx.auditLog.count(),
  ]);

  type AuditRow = { actorType: string; actorId: string | null };
  const staffIds = [
    ...new Set(
      (items as AuditRow[])
        .filter((i) => i.actorType === 'STAFF' && i.actorId)
        .map((i) => i.actorId as string),
    ),
  ];
  const contactIds = [
    ...new Set(
      (items as AuditRow[])
        .filter((i) => i.actorType === 'CLIENT_CONTACT' && i.actorId)
        .map((i) => i.actorId as string),
    ),
  ];
  const [staffRows, contactRows] = await Promise.all([
    staffIds.length
      ? tx.staffUser.findMany({ where: { id: { in: staffIds } }, select: { id: true, fullName: true } })
      : Promise.resolve([]),
    contactIds.length
      ? tx.clientContact.findMany({ where: { id: { in: contactIds } }, select: { id: true, fullName: true } })
      : Promise.resolve([]),
  ]);
  const nameById = new Map<string, string>();
  for (const s of staffRows) nameById.set(s.id, s.fullName);
  for (const c of contactRows) nameById.set(c.id, c.fullName);
  const actorLabel = (a: { actorType: string; actorId: string | null }): string => {
    const role =
      a.actorType === 'STAFF' ? 'Mitarbeiter' : a.actorType === 'CLIENT_CONTACT' ? 'Mandant' : 'System';
    const name = a.actorId ? nameById.get(a.actorId) : undefined;
    return name ? `${role} · ${name}` : role;
  };

  return (
    <ListShell
      icon={Activity}
      title="Letzte Aktivitäten"
      isEmpty={items.length === 0}
      emptyText="Noch keine Aktivitäten."
      footer={`Audit-Kette: ${total} Einträge — alle hash-versiegelt`}
    >
      {items.map(
        (a: {
          id: bigint;
          occurredAt: Date;
          action: string;
          actorType: string;
          actorId: string | null;
          resourceType: string;
        }) => (
          <li key={String(a.id)} className="px-5 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="item-title">{actionLabel(a.action)}</p>
                <p className="text-xs text-muted truncate">
                  {actorLabel(a)}
                  {' · '}
                  {resourceLabel(a.resourceType)}
                </p>
              </div>
              <span className="text-xs text-disabled whitespace-nowrap shrink-0">
                {fmtDateTimeShort(a.occurredAt)}
              </span>
            </div>
          </li>
        ),
      )}
    </ListShell>
  );
}

// --- Upcoming Requests --------------------------------------------------------

export async function UpcomingRequests({ tx }: RenderCtx): Promise<React.ReactNode> {
  const items = await tx.request.findMany({
    where: { status: { in: ['OPEN', 'IN_PROGRESS'] }, dueAt: { not: null } },
    orderBy: { dueAt: 'asc' },
    take: 20,
    include: { client: { select: { id: true, name: true } } },
  });
  return (
    <ListShell title="Fällige Anforderungen" isEmpty={items.length === 0} emptyText="Keine fälligen Anforderungen.">
      {items.map(
        (r: { id: string; title: string; dueAt: Date | null; client: { name: string } }) => (
          <li key={r.id} className="px-5 py-2.5">
            <Link href={`/staff/requests/${r.id}`} className="block hover:bg-gray-50 -mx-5 px-5">
              <p className="item-title">{r.title}</p>
              <p className="text-xs text-muted truncate">
                {r.client.name}
                {r.dueAt ? ` · ${fmtDateShort(r.dueAt)}` : ''}
              </p>
            </Link>
          </li>
        ),
      )}
    </ListShell>
  );
}

// --- GwG läuft bald aus -------------------------------------------------------

export async function GwgExpiring({ tx }: RenderCtx): Promise<React.ReactNode> {
  const cutoff = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
  const checks = await tx.gwgCheck.findMany({
    where: { status: 'VERIFIED', validUntil: { lte: cutoff } },
    orderBy: { validUntil: 'asc' },
    take: 20,
    include: { client: { select: { id: true, name: true } } },
  });
  return (
    <ListShell
      icon={ShieldAlert}
      title="GwG läuft bald aus"
      isEmpty={checks.length === 0}
      emptyText="Alle GwG-Prüfungen aktuell."
    >
      {checks.map(
        (c: { id: string; validUntil: Date | null; client: { id: string; name: string } }) => (
          <li key={c.id} className="px-5 py-2.5">
            <Link href={`/staff/clients/${c.client.id}/gwg`} className="block hover:bg-gray-50 -mx-5 px-5">
              <p className="item-title">{c.client.name}</p>
              <p className="text-xs text-muted truncate">
                {c.validUntil ? `Gültig bis ${fmtDateShort(c.validUntil)}` : 'ohne Gültigkeitsdatum'}
              </p>
            </Link>
          </li>
        ),
      )}
    </ListShell>
  );
}

// --- Ungeprüfte Bescheide -----------------------------------------------------

export async function UnreviewedNotices({ tx }: RenderCtx): Promise<React.ReactNode> {
  const items = await tx.taxNotice.findMany({
    where: { status: 'NEU' },
    orderBy: { createdAt: 'desc' },
    take: 20,
    include: { client: { select: { id: true, name: true } } },
  });
  return (
    <ListShell
      icon={FileWarning}
      title="Ungeprüfte Bescheide"
      isEmpty={items.length === 0}
      emptyText="Alle Bescheide geprüft."
    >
      {items.map(
        (n: { id: string; kind: string; createdAt: Date; client: { id: string; name: string } }) => (
          <li key={n.id} className="px-5 py-2.5">
            <Link href={`/staff/clients/${n.client.id}/notices`} className="block hover:bg-gray-50 -mx-5 px-5">
              <p className="item-title">{n.client.name}</p>
              <p className="text-xs text-muted truncate">
                {NOTICE_KIND_LABELS[n.kind] ?? n.kind} · eingegangen {fmtDateShort(n.createdAt)}
              </p>
            </Link>
          </li>
        ),
      )}
    </ListShell>
  );
}

// --- Steuertermine ------------------------------------------------------------

export async function TaxDeadlines({ tx }: RenderCtx): Promise<React.ReactNode> {
  const items = await tx.taxDeadline.findMany({
    where: { status: { in: ['PLANNED', 'REMINDED', 'IN_PROGRESS', 'OVERDUE'] } },
    orderBy: { dueDate: 'asc' },
    take: 20,
    include: { client: { select: { id: true, name: true } } },
  });
  return (
    <ListShell
      icon={CalendarDays}
      title="Nächste Steuertermine"
      isEmpty={items.length === 0}
      emptyText="Keine Termine."
    >
      {items.map(
        (d: {
          id: string;
          kind: keyof typeof SCHEDULE_LABELS;
          dueDate: Date;
          status: string;
          client: { id: string; name: string };
        }) => (
          <li key={d.id} className="px-5 py-2.5">
            <Link href={`/staff/tax-deadlines`} className="block hover:bg-gray-50 -mx-5 px-5">
              <p className="item-title">{d.client.name}</p>
              <p className="text-xs text-muted truncate">{SCHEDULE_LABELS[d.kind] ?? d.kind}</p>
              <p className={d.status === 'OVERDUE' ? 'text-xs text-red-700' : 'text-xs text-muted'}>
                fällig {fmtDateShort(d.dueDate)}
                {d.status === 'OVERDUE' && ' · überfällig'}
              </p>
            </Link>
          </li>
        ),
      )}
    </ListShell>
  );
}

// --- Telefonzettel ------------------------------------------------------------

export async function PhoneNotesWidget({ tx }: RenderCtx): Promise<React.ReactNode> {
  const items = await tx.phoneNote.findMany({
    where: { doneAt: null },
    orderBy: [{ readAt: 'asc' }, { createdAt: 'desc' }],
    take: 20,
    include: { client: { select: { id: true, name: true } } },
  });
  return (
    <ListShell
      icon={Phone}
      title="Telefonzettel"
      isEmpty={items.length === 0}
      emptyText="Keine Telefonzettel."
      footer={
        <Link href="/staff/phone-notes" className="inline-flex items-center gap-1 text-brand-700 hover:underline">
          <Plus className="h-3.5 w-3.5" />
          Neuen Telefonzettel anlegen
        </Link>
      }
    >
      {items.map(
        (p: {
          id: string;
          subject: string;
          body: string;
          callerName: string;
          callerPhone: string | null;
          readAt: Date | null;
          createdAt: Date;
          client: { id: string; name: string } | null;
        }) => (
          <PhoneNoteRow
            key={p.id}
            id={p.id}
            className={'px-5 py-2.5 ' + (p.readAt ? '' : 'bg-yellow-50/30 dark:bg-yellow-900/10')}
          >
            <Link href="/staff/phone-notes" className="block hover:bg-gray-50 -my-1 py-1 -mr-2 pr-2 rounded">
              <div className="flex items-center justify-between gap-2">
                <p className="item-title">{p.subject}</p>
                {!p.readAt && <span className="badge-yellow text-[10px]">neu</span>}
              </div>
              <p className="text-xs text-muted truncate">
                {p.callerName}
                {p.callerPhone ? ` · ${p.callerPhone}` : ''}
                {p.client ? ` · ${p.client.name}` : ''}
              </p>
              <p className="text-[10px] text-disabled">{fmtDateTimeShort(p.createdAt)}</p>
            </Link>
          </PhoneNoteRow>
        ),
      )}
    </ListShell>
  );
}
