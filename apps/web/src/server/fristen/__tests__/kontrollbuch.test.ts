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

vi.mock('@/server/container', () => ({
  evidenceService: { record: vi.fn() },
}));

import { loadKontrollbuch } from '../kontrollbuch';
import { prepareDailyReview } from '../tagesabschluss';

function createTx() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    taxDeadline: { findMany: vi.fn().mockResolvedValue([]) },
    taxNotice: { findMany: vi.fn().mockResolvedValue([]) },
    request: { findMany: vi.fn().mockResolvedValue([]) },
    clientReminder: { findMany: vi.fn().mockResolvedValue([]) },
    clientResponsibility: { findMany: vi.fn().mockResolvedValue([]) },
    staffUser: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

describe('loadKontrollbuch query bounds', () => {
  // Fachkatalog: TAX-CONTROL-STATUS-001
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
        dueDate: { lte: horizont },
        OR: [
          { status: { not: 'DONE' } },
          { status: 'DONE', completedAt: null },
          { status: 'DONE', completedByStaff: null },
        ],
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
      AND: [
        { OR: [{ appealFiledAt: null }, { appealFiledBy: null }] },
        {
          OR: [
            { status: { not: 'BESTANDSKRAEFTIG' } },
            { legalFinalAt: null },
            { legalFinalBy: null },
            { legalFinalReason: null },
          ],
        },
      ],
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
        'legalFinalReason',
        'manualReviewRequired',
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
      status: {
        in: [
          'TEILEINSPRUCHSENTSCHEIDUNG',
          'ZURUECKGEWIESEN',
          'ABGEHOLFEN',
          'KLAGE',
          'BESTANDSKRAEFTIG',
        ],
      },
      AND: [
        { OR: [{ klageFiledAt: null }, { klageFiledBy: null }] },
        {
          OR: [
            { status: { not: 'BESTANDSKRAEFTIG' } },
            { legalFinalAt: null },
            { legalFinalBy: null },
            { legalFinalReason: null },
          ],
        },
      ],
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
        'legalFinalReason',
        'manualReviewRequired',
        'period',
        'status',
      ].sort(),
    );

    const riskNoticeArgs = tx.taxNotice.findMany.mock.calls[2]![0];
    expect(riskNoticeArgs.where).toEqual({
      clientId: { notIn: ['denied-client'] },
      appealDeadline: null,
      internalRiskDeadline: { lte: horizont },
      deadlineCalculationStatus: { in: ['MANUAL_REVIEW', 'RISK_ONLY'] },
      client: responsibleClient,
    });
    expect(Object.keys(riskNoticeArgs.select).sort()).toEqual(
      [
        'client',
        'clientId',
        'deadlineCalculationStatus',
        'id',
        'internalRiskDeadline',
        'kind',
        'period',
      ].sort(),
    );

    const requestArgs = tx.request.findMany.mock.calls[0]![0];
    expect(requestArgs).toEqual({
      where: {
        clientId: { notIn: ['denied-client'] },
        dueAt: { lte: horizont },
        OR: [
          { status: { not: 'CLOSED' } },
          { status: 'CLOSED', closedAt: null },
          { status: 'CLOSED', closedByStaff: null },
        ],
        client: responsibleClient,
      },
      select: {
        id: true,
        clientId: true,
        title: true,
        dueAt: true,
        status: true,
        closedAt: true,
        closedByStaff: true,
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
          {
            dueDate: { lte: horizont },
            OR: [{ doneAt: null }, { doneByStaff: null }],
          },
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
      status: 'DONE',
      completedAt: { not: null },
      completedByStaff: { not: null },
      dueDate: { gte: new Date('2026-06-16T00:00:00.000Z') },
    });

    const reminderWhere = tx.clientReminder.findMany.mock.calls[0]![0].where;
    // [0] schliesst interne Aufgaben aus, [1] ist das Zeitfenster.
    expect(reminderWhere.AND).toHaveLength(2);
    expect(reminderWhere.AND[0]).toEqual({ NOT: { clientId: null } });
    expect(reminderWhere.AND[1].OR).toHaveLength(2);
    expect(reminderWhere.AND[1].OR[1]).toMatchObject({
      doneAt: { not: null },
      doneByStaff: { not: null },
      dueDate: { gte: new Date('2026-06-16T00:00:00.000Z') },
    });

    const klageWhere = tx.taxNotice.findMany.mock.calls[1]![0].where;
    expect(klageWhere.OR[0].status.in).toContain('TEILEINSPRUCHSENTSCHEIDUNG');
    expect(klageWhere.OR[0].status.in).toContain('ZURUECKGEWIESEN');
    expect(klageWhere.OR[0].status.in).toContain('ABGEHOLFEN');
    expect(klageWhere.OR[0].status.in).not.toContain('TEILABHILFE');
  });

  it('hält die aus einer Teil-Einspruchsentscheidung fortbestehende Klagefrist nach ABGEHOLFEN offen', async () => {
    const tx = createTx();
    tx.taxNotice.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: 'notice-teilentscheidung-abhilfe',
        clientId: 'client-1',
        kind: 'EST',
        period: '2025',
        klageDeadline: new Date('2026-07-20T00:00:00.000Z'),
        status: 'ABGEHOLFEN',
        appealResolvedAt: new Date('2026-06-20T00:00:00.000Z'),
        klageFiledAt: null,
        klageFiledBy: null,
        legalFinalAt: null,
        legalFinalBy: null,
        legalFinalReason: null,
        client: { name: 'Muster GmbH' },
      },
    ]);

    const entries = await loadKontrollbuch(tx as never, {} as never, {
      tage: 30,
      nurOffene: true,
    });

    expect(entries).toEqual([
      expect.objectContaining({
        quelle: 'KLAGEFRIST',
        id: 'notice-teilentscheidung-abhilfe',
        faelligAm: new Date('2026-07-20T00:00:00.000Z'),
        erledigt: false,
        kontrollzustand: 'OPEN',
        erledigtAm: null,
        kontrollhinweis: expect.stringContaining('trotz Abhilfe-Status'),
      }),
    ]);
  });

  it('schließt die fortbestehende Klagefrist nach ABGEHOLFEN nur mit fristwahrendem Einreichungsnachweis', async () => {
    const tx = createTx();
    const filedAt = new Date('2026-07-20T12:00:00.000Z');
    tx.taxNotice.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: 'notice-teilentscheidung-klage',
        clientId: 'client-1',
        kind: 'EST',
        period: '2025',
        klageDeadline: new Date('2026-07-20T00:00:00.000Z'),
        status: 'ABGEHOLFEN',
        appealResolvedAt: new Date('2026-06-20T00:00:00.000Z'),
        klageFiledAt: filedAt,
        klageFiledBy: 'staff-1',
        legalFinalAt: null,
        legalFinalBy: null,
        legalFinalReason: null,
        client: { name: 'Muster GmbH' },
      },
    ]);
    tx.staffUser.findMany.mockResolvedValue([{ id: 'staff-1', fullName: 'Ada Partnerin' }]);

    const entries = await loadKontrollbuch(tx as never, {} as never, { tage: 30 });

    expect(entries).toEqual([
      expect.objectContaining({
        quelle: 'KLAGEFRIST',
        id: 'notice-teilentscheidung-klage',
        erledigt: true,
        kontrollzustand: 'CLOSED_FULFILLED',
        erledigtAm: filedAt,
        erledigtVon: 'Ada Partnerin',
      }),
    ]);
    const klageWhere = tx.taxNotice.findMany.mock.calls[1]![0].where;
    expect(klageWhere.OR[1].OR[0]).toEqual({
      klageFiledAt: { not: null },
      klageFiledBy: { not: null },
    });
  });

  it('führt heutige und überfällige interne Risikotermine ohne Rechtsfrist fail-closed im Tagesabschluss', async () => {
    const tx = createTx();
    tx.taxNotice.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'notice-risk-overdue',
          clientId: 'client-1',
          kind: 'EST',
          period: '2024',
          internalRiskDeadline: new Date('2026-07-15T00:00:00.000Z'),
          deadlineCalculationStatus: 'RISK_ONLY',
          status: 'NEU',
          legalFinalAt: null,
          legalFinalBy: null,
          legalFinalReason: null,
          client: { name: 'Muster GmbH' },
        },
        {
          id: 'notice-risk-today',
          clientId: 'client-1',
          kind: 'KST',
          period: '2025',
          internalRiskDeadline: new Date('2026-07-16T00:00:00.000Z'),
          deadlineCalculationStatus: 'MANUAL_REVIEW',
          status: 'GEPRUEFT',
          legalFinalAt: null,
          legalFinalBy: null,
          legalFinalReason: null,
          client: { name: 'Muster GmbH' },
        },
        {
          id: 'notice-risk-legacy-final',
          clientId: 'client-1',
          kind: 'UST_JAHR',
          period: '2023',
          internalRiskDeadline: new Date('2026-07-14T00:00:00.000Z'),
          deadlineCalculationStatus: 'RISK_ONLY',
          // Owner-/Import-/Legacy-Daten dürfen mangels eigenem strukturiertem
          // Risikoprüffall-Abschluss nicht aus der offenen Sicht verschwinden.
          status: 'BESTANDSKRAEFTIG',
          legalFinalAt: new Date('2026-07-10T00:00:00.000Z'),
          legalFinalBy: 'staff-legacy',
          legalFinalReason: 'Historisch importierte generische Bestandskraft',
          client: { name: 'Muster GmbH' },
        },
      ]);

    const entries = await loadKontrollbuch(tx as never, {} as never, {
      tage: 0,
      nurOffene: true,
      referenceDate: new Date('2026-07-16T00:00:00.000Z'),
    });

    expect(entries).toHaveLength(3);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'notice-risk-overdue',
          quelle: 'EINSPRUCHSFRIST',
          kontrollart: 'INTERNAL_RISK',
          artLabel: 'Interner Prüftermin',
          titel: expect.stringContaining('keine Rechtsbehelfsfrist'),
          faelligAm: new Date('2026-07-15T00:00:00.000Z'),
          erledigt: false,
          kontrollzustand: 'OPEN',
          kontrollhinweis: expect.stringContaining('Interner Risikotermin'),
        }),
        expect.objectContaining({
          id: 'notice-risk-today',
          artLabel: 'Interner Prüftermin',
          titel: expect.stringContaining('keine Rechtsbehelfsfrist'),
          faelligAm: new Date('2026-07-16T00:00:00.000Z'),
          erledigt: false,
          kontrollzustand: 'OPEN',
          kontrollhinweis: expect.stringContaining('ohne berechnete Rechtsbehelfsfrist'),
        }),
        expect.objectContaining({
          id: 'notice-risk-legacy-final',
          erledigt: false,
          kontrollzustand: 'OPEN',
          erledigtAm: null,
          erledigtVon: null,
          kontrollhinweis: expect.stringContaining('noch nicht implementiert'),
        }),
      ]),
    );

    // Derselbe Loader speist die tenantweite Tagesabschlusskontrolle. Beide
    // Prüffälle müssen dort erscheinen; der überfällige darf nicht als 0 offen
    // verschwinden.
    expect(prepareDailyReview(entries, new Date('2026-07-16T00:00:00.000Z'))).toMatchObject({
      openCount: 3,
      overdueCount: 2,
      dueTodayCount: 1,
      snapshot: {
        entries: expect.arrayContaining([
          expect.objectContaining({ id: 'notice-risk-overdue' }),
          expect.objectContaining({ id: 'notice-risk-today' }),
          expect.objectContaining({ id: 'notice-risk-legacy-final' }),
        ]),
      },
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

  it('hält eine verspätete Einspruchseinlegung als Wiedereinsetzungs-Prüffall offen', async () => {
    const tx = createTx();
    tx.$queryRaw.mockResolvedValueOnce([{ id: 'notice-late' }]).mockResolvedValueOnce([]);
    tx.taxNotice.findMany
      .mockResolvedValueOnce([
        {
          id: 'notice-late',
          clientId: 'client-1',
          kind: 'EST',
          period: '2025',
          appealDeadline: new Date('2026-02-10T00:00:00.000Z'),
          manualReviewRequired: false,
          status: 'EINSPRUCH',
          reviewedAt: new Date('2026-02-01T00:00:00.000Z'),
          reviewedBy: 'staff-1',
          appealFiledAt: new Date('2026-02-11T00:00:00.000Z'),
          appealFiledBy: 'staff-1',
          legalFinalAt: null,
          legalFinalBy: null,
          legalFinalReason: null,
          client: { name: 'Muster GmbH' },
        },
      ])
      .mockResolvedValueOnce([]);
    tx.clientResponsibility.findMany.mockResolvedValue([
      { clientId: 'client-1', staffId: 'staff-1' },
    ]);
    tx.staffUser.findMany.mockResolvedValue([{ id: 'staff-1', fullName: 'Ada Partnerin' }]);

    const entries = await loadKontrollbuch(tx as never, {} as never, {
      tage: 30,
      nurOffene: true,
    });

    expect(entries).toEqual([
      expect.objectContaining({
        id: 'notice-late',
        erledigt: false,
        kontrollzustand: 'OPEN',
        erledigtAm: null,
        kontrollhinweis: expect.stringContaining('Wiedereinsetzung'),
      }),
    ]);
    expect(tx.taxNotice.findMany.mock.calls[0]![0].where.AND[0]).toEqual({
      OR: [
        { OR: [{ appealFiledAt: null }, { appealFiledBy: null }] },
        { id: { in: ['notice-late'] } },
      ],
    });
  });
});
