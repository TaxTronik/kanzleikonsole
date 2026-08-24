import { beforeEach, describe, expect, it, vi } from 'vitest';

// Fachkatalog: TAX-CONTROL-STATUS-001

const mocks = vi.hoisted(() => ({
  loadKontrollbuch: vi.fn(),
  record: vi.fn(),
}));

vi.mock('../kontrollbuch', () => ({
  loadKontrollbuch: mocks.loadKontrollbuch,
}));

vi.mock('@/server/container', () => ({
  evidenceService: { record: mocks.record },
}));

import { createDailyReviewTx, loadDailyReviewSummary, prepareDailyReview } from '../tagesabschluss';
import type { FristEintrag } from '../eintrag';

const REVIEW_DATE = new Date('2026-08-23T00:00:00.000Z');

function entry(over: Partial<FristEintrag> = {}): FristEintrag {
  return {
    quelle: 'EINSPRUCHSFRIST',
    kontrollart: 'CALCULATED_CONTROL_PROPOSAL',
    id: 'frist-1',
    titel: 'ESt 2025',
    clientId: 'client-1',
    clientName: 'Muster GmbH',
    faelligAm: REVIEW_DATE,
    erledigt: false,
    kontrollzustand: 'OPEN',
    kontrollhinweis: null,
    erledigtAm: null,
    erledigtVon: null,
    verantwortlich: 'Ada Partnerin',
    verantwortlichId: 'staff-owner',
    href: '/staff/clients/client-1/notices',
    ...over,
  };
}

function createTx() {
  return {
    $queryRaw: vi.fn(),
    deadlineDailyReview: {
      create: vi.fn(),
      findUnique: vi.fn(),
    },
    staffUser: { findFirst: vi.fn() },
  };
}

describe('prepareDailyReview', () => {
  it('nimmt nur offene Fälligkeiten bis einschließlich Kontrolltag in den Snapshot', () => {
    const result = prepareDailyReview(
      [
        entry({ id: 'overdue', faelligAm: new Date('2026-08-20T00:00:00.000Z') }),
        entry({ id: 'today' }),
        entry({ id: 'future', faelligAm: new Date('2026-08-24T00:00:00.000Z') }),
        entry({ id: 'done', erledigt: true }),
      ],
      REVIEW_DATE,
    );

    expect(result).toMatchObject({
      reviewDate: REVIEW_DATE,
      openCount: 2,
      overdueCount: 1,
      dueTodayCount: 1,
    });
    expect(result.snapshot).toEqual({
      version: 1,
      reviewDate: '2026-08-23',
      entries: [
        expect.objectContaining({ id: 'overdue', faelligAm: '2026-08-20' }),
        expect.objectContaining({ id: 'today', faelligAm: '2026-08-23' }),
      ],
    });
    expect(result.snapshot.entries[0]).not.toHaveProperty('clientName');
    expect(result.snapshot.entries[0]).not.toHaveProperty('titel');
  });

  it('bewahrt Rechtsvorschlag, offenen Review und internen Risikotermin im Snapshot', () => {
    const result = prepareDailyReview(
      [
        entry({ id: 'calculated', kontrollart: 'CALCULATED_CONTROL_PROPOSAL' }),
        entry({ id: 'review', kontrollart: 'REVIEW_PENDING_CONTROL_PROPOSAL' }),
        entry({ id: 'risk', kontrollart: 'INTERNAL_RISK' }),
      ],
      REVIEW_DATE,
    );

    expect(result.snapshot.entries).toEqual([
      expect.objectContaining({
        id: 'calculated',
        kontrollart: 'CALCULATED_CONTROL_PROPOSAL',
      }),
      expect.objectContaining({
        id: 'review',
        kontrollart: 'REVIEW_PENDING_CONTROL_PROPOSAL',
      }),
      expect.objectContaining({ id: 'risk', kontrollart: 'INTERNAL_RISK' }),
    ]);
  });
});

describe('createDailyReviewTx', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('verlangt bei offenen Fälligkeiten eine Eskalationsnotiz und schreibt nichts', async () => {
    const tx = createTx();
    mocks.loadKontrollbuch.mockResolvedValue([entry()]);

    await expect(
      createDailyReviewTx(tx as never, {
        tenantId: 'tenant-1',
        staffId: 'staff-reviewer',
        session: {} as never,
        escalationNote: ' ',
        reviewDate: REVIEW_DATE,
      }),
    ).rejects.toThrow(/Eskalationsnotiz erforderlich/);

    expect(tx.deadlineDailyReview.create).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('schreibt Snapshot und Audit atomar mit getrennter Fälligkeitszählung', async () => {
    const tx = createTx();
    const reviewedAt = new Date('2026-08-23T18:05:00.000Z');
    mocks.loadKontrollbuch.mockResolvedValue([
      entry({ id: 'overdue', faelligAm: new Date('2026-08-22T00:00:00.000Z') }),
      entry({ id: 'today' }),
    ]);
    tx.deadlineDailyReview.create.mockResolvedValue({
      id: 'review-1',
      reviewDate: REVIEW_DATE,
      snapshotAt: new Date('2026-08-23T18:04:59.000Z'),
      reviewedAt,
      reviewedBy: 'staff-reviewer',
      openCount: 2,
      overdueCount: 1,
      dueTodayCount: 1,
      escalationNote: 'Partnerin übernimmt beide Fristen heute.',
    });

    const result = await createDailyReviewTx(tx as never, {
      tenantId: 'tenant-1',
      staffId: 'staff-reviewer',
      session: {} as never,
      escalationNote: '  Partnerin übernimmt beide Fristen heute.  ',
      reviewDate: REVIEW_DATE,
    });

    expect(mocks.loadKontrollbuch).toHaveBeenCalledWith(tx, expect.anything(), {
      tage: 0,
      nurOffene: true,
      nurStaffId: null,
      sources: { taxNotices: true, reminders: true },
      referenceDate: REVIEW_DATE,
    });
    expect(tx.deadlineDailyReview.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant-1',
          reviewedBy: 'staff-reviewer',
          openCount: 2,
          overdueCount: 1,
          dueTodayCount: 1,
          escalationNote: 'Partnerin übernimmt beide Fristen heute.',
          entriesSnapshot: expect.objectContaining({ version: 1 }),
        }),
      }),
    );
    expect(mocks.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'fristen.daily_review.complete',
        resourceType: 'deadline_daily_review',
        resourceId: 'review-1',
        after: expect.objectContaining({ openCount: 2, snapshotVersion: 1 }),
      }),
    );
    expect(result).toMatchObject({ id: 'review-1', reviewerName: null });
  });

  it('erlaubt ohne offene Fälligkeit einen Abschluss ohne Notiz', async () => {
    const tx = createTx();
    mocks.loadKontrollbuch.mockResolvedValue([]);
    tx.deadlineDailyReview.create.mockResolvedValue({
      id: 'review-empty',
      reviewDate: REVIEW_DATE,
      snapshotAt: new Date('2026-08-23T18:04:59.000Z'),
      reviewedAt: new Date('2026-08-23T18:05:00.000Z'),
      reviewedBy: 'staff-reviewer',
      openCount: 0,
      overdueCount: 0,
      dueTodayCount: 0,
      escalationNote: null,
    });

    await expect(
      createDailyReviewTx(tx as never, {
        tenantId: 'tenant-1',
        staffId: 'staff-reviewer',
        session: {} as never,
        reviewDate: REVIEW_DATE,
      }),
    ).resolves.toMatchObject({ openCount: 0 });
  });

  it('bestimmt den Kontrolltag einmal aus der DB-Uhr und reicht ihn an alle Reads durch', async () => {
    const tx = createTx();
    tx.$queryRaw.mockResolvedValue([{ reviewDate: REVIEW_DATE }]);
    mocks.loadKontrollbuch.mockResolvedValue([]);
    tx.deadlineDailyReview.create.mockResolvedValue({
      id: 'review-db-clock',
      reviewDate: REVIEW_DATE,
      snapshotAt: new Date('2026-08-23T18:04:59.000Z'),
      reviewedAt: new Date('2026-08-23T18:05:00.000Z'),
      reviewedBy: 'staff-reviewer',
      openCount: 0,
      overdueCount: 0,
      dueTodayCount: 0,
      escalationNote: null,
    });

    await createDailyReviewTx(tx as never, {
      tenantId: 'tenant-1',
      staffId: 'staff-reviewer',
      session: {} as never,
    });

    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(mocks.loadKontrollbuch).toHaveBeenCalledWith(
      tx,
      expect.anything(),
      expect.objectContaining({ referenceDate: REVIEW_DATE }),
    );
    expect(tx.deadlineDailyReview.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reviewDate: REVIEW_DATE }) }),
    );
  });
});

describe('loadDailyReviewSummary', () => {
  it('lädt den heutigen tenantgebundenen Abschluss und den Namen der prüfenden Person', async () => {
    const tx = createTx();
    tx.deadlineDailyReview.findUnique.mockResolvedValue({
      id: 'review-1',
      reviewDate: REVIEW_DATE,
      snapshotAt: new Date('2026-08-23T18:04:59.000Z'),
      reviewedAt: new Date('2026-08-23T18:05:00.000Z'),
      reviewedBy: 'staff-reviewer',
      openCount: 1,
      overdueCount: 1,
      dueTodayCount: 0,
      escalationNote: 'In Bearbeitung.',
    });
    tx.staffUser.findFirst.mockResolvedValue({ fullName: 'Ada Partnerin' });

    await expect(
      loadDailyReviewSummary(tx as never, 'tenant-1', REVIEW_DATE),
    ).resolves.toMatchObject({ reviewerName: 'Ada Partnerin' });
    expect(tx.deadlineDailyReview.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId_reviewDate: { tenantId: 'tenant-1', reviewDate: REVIEW_DATE } },
      }),
    );
  });
});
