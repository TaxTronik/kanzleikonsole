import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  accessibleClientsWhereFor: vi.fn(),
}));

vi.mock('@/server/auth/rbac', () => ({
  accessibleClientsWhereFor: mocks.accessibleClientsWhereFor,
}));

vi.mock('@/lib/fmt', () => ({
  berlinTodayUtcMidnight: () => new Date('2026-07-16T00:00:00.000Z'),
}));

vi.mock('@/server/container', () => ({
  evidenceService: { record: vi.fn() },
}));

import { loadKontrollbuch, loadKontrollbuchSeite } from '../kontrollbuch';
import { prepareDailyReview } from '../tagesabschluss';

// OPEN-Regel eines Nicht-Admins (Form wie accessibleClientsWhereFor).
const clientAccess = {
  OR: [{ vertraulich: false }, { responsibilities: { some: { staffId: 'staff-1' } } }],
};

function createTx() {
  const model = () => ({
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
  });
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    taxDeadline: model(),
    taxNotice: model(),
    request: model(),
    clientReminder: model(),
    clientResponsibility: { findMany: vi.fn().mockResolvedValue([]) },
    staffUser: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

describe('loadKontrollbuch query bounds', () => {
  // Fachkatalog: TAX-CONTROL-STATUS-001
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.accessibleClientsWhereFor.mockResolvedValue(clientAccess);
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
        dueDate: { lte: horizont },
        OR: [
          { status: { not: 'DONE' } },
          { status: 'DONE', completedAt: null },
          { status: 'DONE', completedByStaff: null },
        ],
        client: { AND: [clientAccess, responsibleClient] },
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
      client: { AND: [clientAccess, responsibleClient] },
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
      client: { AND: [clientAccess, responsibleClient] },
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
      appealDeadline: null,
      internalRiskDeadline: { lte: horizont },
      deadlineCalculationStatus: { in: ['MANUAL_REVIEW', 'RISK_ONLY'] },
      client: { AND: [clientAccess, responsibleClient] },
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
        dueAt: { lte: horizont },
        OR: [
          { status: { not: 'CLOSED' } },
          { status: 'CLOSED', closedAt: null },
          { status: 'CLOSED', closedByStaff: null },
        ],
        client: { AND: [clientAccess, responsibleClient] },
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
        client: clientAccess,
        AND: [
          // Interne Aufgaben (ohne Mandant) gehoeren nicht ins Fristenbuch —
          // als eigener AND-Zweig (fuer Admin/Partner setzt der
          // Relationsfilter keine Bedingung).
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
        // Gleichzeitig angelegte Zuweisungen: die Personen-ID entscheidet stabil.
        assignees: {
          select: { staffId: true },
          orderBy: [{ createdAt: 'asc' }, { staffId: 'asc' }],
        },
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
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: 'notice-late', verspaetet: true, ohneBegruendung: false }])
      .mockResolvedValueOnce([]);
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

describe('loadKontrollbuchSeite Abfragen', () => {
  // Fachkatalog: TAX-CONTROL-STATUS-001 — Review-Befund K-05: Die Seite blättert
  // nur im sicher offenen Zweig; verspätete Einlegungen (Status erst nach
  // toEintrag) werden vollständig geladen, Zählwerte nutzen denselben Filter.
  const heute = new Date('2026-07-16T00:00:00.000Z');
  const horizont = new Date('2026-08-15T00:00:00.000Z');
  const visible = { client: clientAccess };
  const filingMissing = { OR: [{ appealFiledAt: null }, { appealFiledBy: null }] };
  const dispositionMissing = {
    OR: [
      { status: { not: 'BESTANDSKRAEFTIG' } },
      { legalFinalAt: null },
      { legalFinalBy: null },
      { legalFinalReason: null },
    ],
  };
  const appealOffen = {
    appealDeadline: { lte: horizont },
    AND: [{ OR: [filingMissing, { id: { in: ['notice-late'] } }] }, dispositionMissing],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.accessibleClientsWhereFor.mockResolvedValue(clientAccess);
  });

  it('zählt und blättert den sicher offenen Zweig, verspätete Einlegungen vollständig', async () => {
    const tx = createTx();
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: 'notice-late', verspaetet: true, ohneBegruendung: false }])
      .mockResolvedValueOnce([]);
    tx.taxNotice.count.mockResolvedValue(12);
    tx.taxDeadline.count.mockResolvedValue(12);

    const seite = await loadKontrollbuchSeite(tx as never, {} as never, {
      tage: 30,
      nurOffene: true,
      seite: 2,
      seitenGroesse: 5,
      tagesabschluss: true,
    });

    const sicher = { ...appealOffen, id: { notIn: ['notice-late'] }, ...visible };
    expect(tx.taxNotice.count.mock.calls.slice(0, 3)).toEqual([
      [{ where: sicher }],
      [{ where: { AND: [sicher, { appealDeadline: { lt: heute } }] } }],
      [{ where: { AND: [sicher, { appealDeadline: { lte: heute } }] } }],
    ]);
    // [0] Vorbehalt vollständig, danach die Seitenabfragen je Bescheidquelle.
    expect(tx.taxNotice.findMany.mock.calls[0]![0]).toEqual({
      where: { ...appealOffen, id: { in: ['notice-late'] }, ...visible },
      select: expect.any(Object),
    });
    expect(tx.taxNotice.findMany.mock.calls[1]![0]).toEqual({
      where: sicher,
      orderBy: [{ appealDeadline: 'asc' }, { id: 'asc' }],
      take: 10,
      select: expect.any(Object),
    });
    expect(tx.taxNotice.findMany.mock.calls[2]![0]).toMatchObject({
      orderBy: [{ klageDeadline: 'asc' }, { id: 'asc' }],
      take: 10,
    });
    expect(tx.taxNotice.findMany.mock.calls[3]![0]).toMatchObject({
      orderBy: [{ internalRiskDeadline: 'asc' }, { id: 'asc' }],
      take: 10,
    });
    expect(tx.taxNotice.findMany).toHaveBeenCalledTimes(4);
    expect(tx.taxDeadline.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ dueDate: 'asc' }, { id: 'asc' }], take: 10 }),
    );
    // Quellen ohne offene Zeilen werden nicht abgefragt; ohne Rückschau kein Erledigt-Zweig.
    expect(tx.request.findMany).not.toHaveBeenCalled();
    expect(tx.clientReminder.findMany).not.toHaveBeenCalled();
    // 12 je Steuertermine + drei Bescheidquellen; Vorbehalt und Seite selbst sind leer.
    expect(seite).toMatchObject({
      heute,
      offenGesamt: 48,
      seite: 2,
      seitenGroesse: 5,
      tagesabschluss: { offen: 48, ueberfaellig: 48 },
    });
  });

  it('lädt mit Erledigten den Rückschau-Zweig je Quelle vollständig', async () => {
    const tx = createTx();

    await loadKontrollbuchSeite(tx as never, {} as never, {
      tage: 30,
      seite: 1,
      seitenGroesse: 200,
    });

    expect(tx.taxDeadline.findMany).toHaveBeenCalledWith({
      where: {
        status: 'DONE',
        completedAt: { not: null },
        completedByStaff: { not: null },
        dueDate: { gte: new Date('2026-06-16T00:00:00.000Z'), lte: horizont },
        ...visible,
      },
      select: expect.any(Object),
    });
    expect(tx.request.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'CLOSED', closedByStaff: { not: null } }),
      }),
    );
    // Klagefrist-Rückschau ohne Statusfilter; interne Prüftermine haben keinen.
    expect(tx.taxNotice.findMany).toHaveBeenCalledTimes(2);
    expect(tx.clientReminder.findMany).toHaveBeenCalledTimes(1);
    // Ohne Anforderung keine Abschluss-Zählung.
    expect(tx.taxDeadline.count).toHaveBeenCalledTimes(2);
  });
});

describe('Bescheid-Vorabfragen (Review-Finding K-05, Folgepunkte)', () => {
  // Fachkatalog: TAX-CONTROL-STATUS-001
  const horizont = new Date('2026-08-15T00:00:00.000Z');
  const dispositionOffen = (ids: string[]) => ({
    OR: [
      { status: { not: 'BESTANDSKRAEFTIG' } },
      { legalFinalAt: null },
      { legalFinalBy: null },
      { legalFinalReason: null },
      { id: { in: ids } },
    ],
  });
  const bestandskraftOhneBegruendung = {
    id: 'notice-blank',
    clientId: 'client-1',
    kind: 'EST',
    period: '2025',
    appealDeadline: new Date('2026-07-10T00:00:00.000Z'),
    manualReviewRequired: false,
    status: 'BESTANDSKRAEFTIG',
    reviewedAt: new Date('2026-06-02T00:00:00.000Z'),
    reviewedBy: 'staff-1',
    appealFiledAt: null,
    appealFiledBy: null,
    legalFinalAt: new Date('2026-07-11T08:00:00.000Z'),
    legalFinalBy: 'staff-1',
    // Altbestand vor der DB-Prüfung: nur Tabs und Zeilenumbrüche.
    legalFinalReason: '\t\t\t\t\t\n\n\n\n\n',
    client: { name: 'Muster GmbH' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.accessibleClientsWhereFor.mockResolvedValue(clientAccess);
  });

  // Fachkatalog: TAX-CONTROL-STATUS-001 — Produktentscheidung A3: Einlegungstag ist der
  // Berliner Kalendertag wie in filingWithinDeadline; das Verhalten gegen PostgreSQL
  // in fünf Sitzungszeitzonen prüft bescheid-vorab-db.test.ts.
  it('nutzt den Berliner Kalendertag der Einlegung und die Begründungsprüfung der Datenbank', async () => {
    const tx = createTx();

    await loadKontrollbuch(tx as never, {} as never, { tage: 30, nurOffene: true });

    const sql = tx.$queryRaw.mock.calls.map(([strings]) =>
      (strings as string[]).join('?').replace(/\s+/g, ' '),
    );
    expect(sql).toHaveLength(2);
    expect(sql[0]).toContain(
      `COALESCE( (("appeal_filed_at" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date > "appeal_deadline", false )`,
    );
    expect(sql[1]).toContain(
      `COALESCE( (("klage_filed_at" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date > "klage_deadline", false )`,
    );
    for (const text of sql) {
      // Kein UTC-Tag (`col::date`) und kein Schnitt in der Zeitzone der DB-Sitzung
      // (früher `AT TIME ZONE 'UTC'` + `::date` auf dem timestamptz).
      expect(text).not.toMatch(/_filed_at"::date/);
      expect(text).not.toMatch(/AT TIME ZONE 'UTC'\)::date/);
      expect(text).toContain('NOT app.legal_final_reason_sufficient("legal_final_reason")');
    }
  });

  it('führt Bestandskraft ohne tragfähige Begründung im offenen Zweig und zählt sie', async () => {
    const tx = createTx();
    tx.$queryRaw.mockResolvedValueOnce([
      { id: 'notice-blank', verspaetet: false, ohneBegruendung: true },
    ]);
    tx.taxNotice.findMany.mockResolvedValueOnce([bestandskraftOhneBegruendung]);

    const entries = await loadKontrollbuch(tx as never, {} as never, {
      tage: 30,
      nurOffene: true,
    });

    expect(entries).toEqual([
      expect.objectContaining({ id: 'notice-blank', erledigt: false, kontrollzustand: 'OPEN' }),
    ]);
    expect(tx.taxNotice.findMany.mock.calls[0]![0].where).toEqual({
      appealDeadline: { lte: horizont },
      AND: [
        { OR: [{ appealFiledAt: null }, { appealFiledBy: null }] },
        dispositionOffen(['notice-blank']),
      ],
      client: clientAccess,
    });

    const zaehlung = createTx();
    zaehlung.$queryRaw.mockResolvedValueOnce([
      { id: 'notice-blank', verspaetet: false, ohneBegruendung: true },
    ]);
    await loadKontrollbuchSeite(zaehlung as never, {} as never, {
      tage: 30,
      nurOffene: true,
      seite: 1,
      seitenGroesse: 0,
      tagesabschluss: true,
    });
    // Seite, Überfällig-Zähler und Tagesabschluss zählen denselben offenen Zweig.
    for (const [args] of zaehlung.taxNotice.count.mock.calls.slice(0, 3)) {
      expect(JSON.stringify(args)).toContain('"in":["notice-blank"]');
    }
  });

  it('schließt sie im Rückschau-Zweig nicht als dokumentierte Disposition', async () => {
    const tx = createTx();
    tx.$queryRaw.mockResolvedValueOnce([
      { id: 'notice-blank', verspaetet: false, ohneBegruendung: true },
    ]);

    await loadKontrollbuch(tx as never, {} as never, { tage: 30 });

    const fenster = tx.taxNotice.findMany.mock.calls[0]![0].where;
    const [, erledigt] = fenster.OR;
    expect(erledigt.OR[1]).toEqual({
      status: 'BESTANDSKRAEFTIG',
      legalFinalAt: { not: null },
      legalFinalBy: { not: null },
      legalFinalReason: { not: null },
      id: { notIn: ['notice-blank'] },
    });
  });
});
