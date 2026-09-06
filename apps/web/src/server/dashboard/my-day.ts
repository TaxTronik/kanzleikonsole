import type { TxClient } from '@taxtronik/db';

const DEFAULT_MY_DAY_LIMIT = 20;

export type MyDayEntry =
  | {
      kind: 'workflow';
      id: string;
      title: string;
      href: string;
      context: string;
      dueAt: Date | null;
      sortAt: Date | null;
    }
  | {
      kind: 'reminder';
      id: string;
      title: string;
      href: string;
      context: string;
      dueAt: Date;
      sortAt: Date;
    }
  | {
      kind: 'appointment';
      id: string;
      title: string;
      href: string;
      context: string;
      startsAt: Date;
      endsAt: Date;
      sortAt: Date;
    }
  | {
      kind: 'phone-note';
      id: string;
      title: string;
      href: string;
      context: string;
      receivedAt: Date;
      sortAt: Date;
    };

export interface MyDaySources {
  workflows: boolean;
  reminders: boolean;
  appointments: boolean;
  phoneNotes: boolean;
}

const ALL_MY_DAY_SOURCES: MyDaySources = {
  workflows: true,
  reminders: true,
  appointments: true,
  phoneNotes: true,
};

function nullableClientVisibility(deniedClientIds: string[] | undefined) {
  return deniedClientIds?.length
    ? { OR: [{ clientId: null }, { clientId: { notIn: deniedClientIds } }] }
    : {};
}

/**
 * Persönliche Arbeitsliste für das Dashboard. Anders als das eigenständige
 * Kalender-Widget enthält sie nur Objekte, für die der aktuelle Mitarbeiter
 * tatsächlich zuständig ist.
 */
export async function loadMyDayEntries(
  tx: TxClient,
  staffId: string,
  deniedClientIds?: string[],
  now = new Date(),
  sources: MyDaySources = ALL_MY_DAY_SOURCES,
  limit = DEFAULT_MY_DAY_LIMIT,
): Promise<MyDayEntry[]> {
  const queryLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
  const reminderAssignment = {
    OR: [
      { assignees: { some: { staffId } } },
      { assignees: { none: {} }, createdByStaff: staffId },
    ],
  };
  const reminderVisibility = nullableClientVisibility(deniedClientIds);

  const [workflowItems, reminders, appointments, phoneNotes] = await Promise.all([
    sources.workflows
      ? tx.workflowItem.findMany({
          where: {
            assigneeStaffId: staffId,
            doneAt: null,
            instance: {
              status: 'ACTIVE',
              ...(deniedClientIds?.length ? { clientId: { notIn: deniedClientIds } } : {}),
            },
          },
          orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
          take: queryLimit,
          select: {
            id: true,
            title: true,
            dueDate: true,
            instance: {
              select: { clientId: true, name: true, client: { select: { name: true } } },
            },
          },
        })
      : Promise.resolve([]),
    sources.reminders
      ? tx.clientReminder.findMany({
          where: {
            doneAt: null,
            ...(deniedClientIds?.length
              ? { AND: [reminderAssignment, reminderVisibility] }
              : reminderAssignment),
          },
          orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
          take: queryLimit,
          select: {
            id: true,
            subject: true,
            dueDate: true,
            client: { select: { name: true } },
          },
        })
      : Promise.resolve([]),
    sources.appointments
      ? tx.appointment.findMany({
          where: {
            ownerStaffId: staffId,
            status: { not: 'CANCELLED' },
            endsAt: { gte: now },
            ...nullableClientVisibility(deniedClientIds),
          },
          orderBy: { startsAt: 'asc' },
          take: queryLimit,
          select: {
            id: true,
            title: true,
            startsAt: true,
            endsAt: true,
            location: true,
            client: { select: { name: true } },
          },
        })
      : Promise.resolve([]),
    sources.phoneNotes
      ? tx.phoneNote.findMany({
          where: {
            forwardToStaff: staffId,
            doneAt: null,
            ...nullableClientVisibility(deniedClientIds),
          },
          orderBy: { createdAt: 'asc' },
          take: queryLimit,
          select: {
            id: true,
            subject: true,
            callerName: true,
            createdAt: true,
            client: { select: { name: true } },
          },
        })
      : Promise.resolve([]),
  ]);

  const entries: MyDayEntry[] = [
    ...workflowItems.map((item) => ({
      kind: 'workflow' as const,
      id: item.id,
      title: item.title,
      href: `/staff/clients/${item.instance.clientId}/workflows`,
      context: `${item.instance.client.name} · ${item.instance.name}`,
      dueAt: item.dueDate,
      sortAt: item.dueDate,
    })),
    ...reminders.map((reminder) => ({
      kind: 'reminder' as const,
      id: reminder.id,
      title: reminder.subject,
      href: `/staff/reminders/${reminder.id}`,
      context: reminder.client?.name ?? 'Intern (ohne Mandant)',
      dueAt: reminder.dueDate,
      sortAt: reminder.dueDate,
    })),
    ...appointments.map((appointment) => ({
      kind: 'appointment' as const,
      id: appointment.id,
      title: appointment.title,
      href: '/staff/calendar',
      context: [appointment.client?.name, appointment.location].filter(Boolean).join(' · '),
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      sortAt: appointment.startsAt,
    })),
    ...phoneNotes.map((note) => ({
      kind: 'phone-note' as const,
      id: note.id,
      title: note.subject,
      href: '/staff/phone-notes',
      context: [note.callerName, note.client?.name].filter(Boolean).join(' · '),
      receivedAt: note.createdAt,
      sortAt: note.createdAt,
    })),
  ];

  return entries
    .sort((a, b) => {
      if (a.sortAt === null) return b.sortAt === null ? a.title.localeCompare(b.title, 'de') : 1;
      if (b.sortAt === null) return -1;
      const byDate = a.sortAt.getTime() - b.sortAt.getTime();
      return byDate || a.title.localeCompare(b.title, 'de');
    })
    .slice(0, queryLimit);
}
