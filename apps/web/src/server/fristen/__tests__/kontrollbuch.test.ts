import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  inaccessibleClientIdsFor: vi.fn(),
}));

vi.mock('@/server/auth/rbac', () => ({
  inaccessibleClientIdsFor: mocks.inaccessibleClientIdsFor,
}));

vi.mock('@/lib/fmt', () => ({
  berlinTodayUtcMidnight: () => new Date('2026-07-16T00:00:00.000Z'),
}));

import { loadKontrollbuch } from '../kontrollbuch';

function createTx() {
  return {
    taxDeadline: { findMany: vi.fn().mockResolvedValue([]) },
    taxNotice: { findMany: vi.fn().mockResolvedValue([]) },
    request: { findMany: vi.fn().mockResolvedValue([]) },
    clientReminder: { findMany: vi.fn().mockResolvedValue([]) },
    clientResponsibility: { findMany: vi.fn().mockResolvedValue([]) },
    staffUser: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

describe('loadKontrollbuch query bounds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inaccessibleClientIdsFor.mockResolvedValue(['denied-client']);
  });

  it('zieht nurOffene und nurStaffId in alle Quellabfragen und nutzt minimale Selects', async () => {
    const tx = createTx();

    await loadKontrollbuch(tx as never, {} as never, {
      tage: 30,
      nurOffene: true,
      nurStaffId: 'staff-1',
    });

    const responsibleClient = {
      responsibilities: {
        some: { role: 'HAUPTBEARBEITER', staffId: 'staff-1' },
      },
    };
    const horizont = new Date('2026-08-15T00:00:00.000Z');

    const deadlineArgs = tx.taxDeadline.findMany.mock.calls[0]![0];
    expect(deadlineArgs).toEqual({
      where: {
        clientId: { notIn: ['denied-client'] },
        status: { notIn: ['DONE', 'SKIPPED'] },
        dueDate: { lte: horizont },
        client: responsibleClient,
      },
      select: {
        id: true,
        clientId: true,
        kind: true,
        period: true,
        dueDate: true,
        status: true,
        completedAt: true,
        completedByStaff: true,
        client: { select: { name: true } },
      },
    });

    const noticeArgs = tx.taxNotice.findMany.mock.calls[0]![0];
    expect(noticeArgs.where).toEqual({
      clientId: { notIn: ['denied-client'] },
      appealDeadline: { lte: horizont },
      status: { in: ['NEU', 'GEPRUEFT'] },
      client: responsibleClient,
    });
    expect(Object.keys(noticeArgs.select).sort()).toEqual(
      [
        'appealDeadline',
        'appealFiledAt',
        'appealFiledBy',
        'client',
        'clientId',
        'id',
        'kind',
        'legalFinalAt',
        'legalFinalBy',
        'period',
        'reviewedAt',
        'reviewedBy',
        'status',
      ].sort(),
    );

    const klageArgs = tx.taxNotice.findMany.mock.calls[1]![0];
    expect(klageArgs.where).toEqual({
      clientId: { notIn: ['denied-client'] },
      klageDeadline: { lte: horizont },
      status: { in: ['ZURUECKGEWIESEN', 'TEILABHILFE'] },
      client: responsibleClient,
    });
    expect(Object.keys(klageArgs.select).sort()).toEqual(
      [
        'appealResolvedAt',
        'client',
        'clientId',
        'id',
        'kind',
        'klageDeadline',
        'klageFiledAt',
        'klageFiledBy',
        'legalFinalAt',
        'legalFinalBy',
        'period',
        'status',
      ].sort(),
    );

    const requestArgs = tx.request.findMany.mock.calls[0]![0];
    expect(requestArgs).toEqual({
      where: {
        clientId: { notIn: ['denied-client'] },
        dueAt: { lte: horizont },
        status: { in: ['OPEN', 'IN_PROGRESS', 'RESPONDED'] },
        client: responsibleClient,
      },
      select: {
        id: true,
        clientId: true,
        title: true,
        dueAt: true,
        status: true,
        client: { select: { name: true } },
      },
    });

    const reminderArgs = tx.clientReminder.findMany.mock.calls[0]![0];
    expect(reminderArgs).toEqual({
      where: {
        clientId: { notIn: ['denied-client'] },
        AND: [
          // Interne Aufgaben (ohne Mandant) gehoeren nicht ins Fristenbuch —
          // als AND-Zweig, damit der notIn-Filter oben erhalten bleibt.
          { NOT: { clientId: null } },
          { doneAt: null, dueDate: { lte: horizont } },
          {
            OR: [
              { assignees: { some: { staffId: 'staff-1' } } },
              { assignees: { none: {} }, client: responsibleClient },
            ],
          },
        ],
      },
      select: {
        id: true,
        clientId: true,
        subject: true,
        dueDate: true,
        assignees: { select: { staffId: true }, orderBy: { createdAt: 'asc' } },
        doneAt: true,
        doneByStaff: true,
        client: { select: { name: true } },
      },
    });

    expect(tx.clientResponsibility.findMany).not.toHaveBeenCalled();
    expect(tx.staffUser.findMany).not.toHaveBeenCalled();
  });

  it('behält für den Nachweis die erledigten Rückschau-Zweige bei', async () => {
    const tx = createTx();

    await loadKontrollbuch(tx as never, {} as never, { tage: 30 });

    const deadlineWhere = tx.taxDeadline.findMany.mock.calls[0]![0].where;
    expect(deadlineWhere.OR).toHaveLength(2);
    expect(deadlineWhere.OR[1]).toMatchObject({
      status: { in: ['DONE', 'SKIPPED'] },
      dueDate: { gte: new Date('2026-06-16T00:00:00.000Z') },
    });

    const reminderWhere = tx.clientReminder.findMany.mock.calls[0]![0].where;
    // [0] schliesst interne Aufgaben aus, [1] ist das Zeitfenster.
    expect(reminderWhere.AND).toHaveLength(2);
    expect(reminderWhere.AND[0]).toEqual({ NOT: { clientId: null } });
    expect(reminderWhere.AND[1].OR).toHaveLength(2);
    expect(reminderWhere.AND[1].OR[1]).toMatchObject({
      doneAt: { not: null },
      dueDate: { gte: new Date('2026-06-16T00:00:00.000Z') },
    });
  });

  it('überspringt deaktivierte Steuer- und Wiedervorlage-Quellen vollständig', async () => {
    const tx = createTx();

    await loadKontrollbuch(tx as never, {} as never, {
      tage: 30,
      sources: { taxNotices: false, reminders: false },
    });

    expect(tx.taxDeadline.findMany).not.toHaveBeenCalled();
    expect(tx.taxNotice.findMany).not.toHaveBeenCalled();
    expect(tx.clientReminder.findMany).not.toHaveBeenCalled();
    expect(tx.request.findMany).toHaveBeenCalledOnce();
  });
});
