import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loadMyDayEntries } from '../my-day';

function createTx() {
  return {
    workflowItem: { findMany: vi.fn() },
    clientReminder: { findMany: vi.fn() },
    appointment: { findMany: vi.fn() },
    phoneNote: { findMany: vi.fn() },
  };
}

describe('loadMyDayEntries', () => {
  const tx = createTx();

  beforeEach(() => {
    vi.clearAllMocks();
    tx.workflowItem.findMany.mockResolvedValue([]);
    tx.clientReminder.findMany.mockResolvedValue([]);
    tx.appointment.findMany.mockResolvedValue([]);
    tx.phoneNote.findMany.mockResolvedValue([]);
  });

  it('bündelt die persönlich zugewiesenen Quellen chronologisch', async () => {
    tx.workflowItem.findMany.mockResolvedValue([
      {
        id: 'workflow-1',
        title: 'Unterlagen prüfen',
        dueDate: null,
        instance: {
          clientId: 'client-1',
          name: 'Jahresabschluss',
          client: { name: 'Muster GmbH' },
        },
      },
    ]);
    tx.clientReminder.findMany.mockResolvedValue([
      {
        id: 'reminder-1',
        subject: 'Rückruf',
        dueDate: new Date('2026-08-05T00:00:00.000Z'),
        client: null,
      },
    ]);
    tx.appointment.findMany.mockResolvedValue([
      {
        id: 'appointment-1',
        title: 'Besprechung',
        startsAt: new Date('2026-08-06T08:00:00.000Z'),
        endsAt: new Date('2026-08-06T09:00:00.000Z'),
        location: 'Kanzlei',
        client: { name: 'Muster GmbH' },
      },
    ]);
    tx.phoneNote.findMany.mockResolvedValue([
      {
        id: 'phone-1',
        subject: 'Bitte zurückrufen',
        callerName: 'Erika Beispiel',
        createdAt: new Date('2026-08-04T10:00:00.000Z'),
        client: null,
      },
    ]);

    const result = await loadMyDayEntries(
      tx as never,
      'staff-1',
      ['restricted-client'],
      new Date('2026-08-05T12:00:00.000Z'),
    );

    expect(result.map((entry) => entry.kind)).toEqual([
      'phone-note',
      'reminder',
      'appointment',
      'workflow',
    ]);
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'workflow',
          href: '/staff/clients/client-1/workflows',
        }),
        expect.objectContaining({
          kind: 'reminder',
          href: '/staff/reminders/reminder-1',
          context: 'Intern (ohne Mandant)',
        }),
      ]),
    );
  });

  it('grenzt jede Quelle auf Zuständigkeit und sichtbare Mandanten ein', async () => {
    const now = new Date('2026-08-05T12:00:00.000Z');

    await loadMyDayEntries(tx as never, 'staff-1', ['restricted-client'], now);

    expect(tx.workflowItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          assigneeStaffId: 'staff-1',
          doneAt: null,
          instance: { status: 'ACTIVE', clientId: { notIn: ['restricted-client'] } },
        },
      }),
    );
    expect(tx.clientReminder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          doneAt: null,
          AND: expect.arrayContaining([
            {
              OR: [
                { assignees: { some: { staffId: 'staff-1' } } },
                { assignees: { none: {} }, createdByStaff: 'staff-1' },
              ],
            },
            {
              OR: [{ clientId: null }, { clientId: { notIn: ['restricted-client'] } }],
            },
          ]),
        }),
      }),
    );
    expect(tx.appointment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          ownerStaffId: 'staff-1',
          status: { not: 'CANCELLED' },
          endsAt: { gte: now },
        }),
      }),
    );
    expect(tx.phoneNote.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          forwardToStaff: 'staff-1',
          doneAt: null,
        }),
      }),
    );
  });
});
