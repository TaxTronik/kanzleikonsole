// Fachkatalog: YEAR-END-CAMPAIGN-001
// P-19: Die Übersicht zählt Phasen per groupBy und lädt Kampagnen und Einträge
// seitenweise; die Datenbankfilter müssen exakt campaignSubmissionPhase folgen.
// Der Fortschritt kommt gespeichert aus der Einreichung; Schema und Antworten
// werden nur für Einreichungen ohne gespeicherten Wert geladen.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';

const m = vi.hoisted(() => ({ accessibleClientsWhereFor: vi.fn() }));
vi.mock('@/server/auth/rbac', () => ({ accessibleClientsWhereFor: m.accessibleClientsWhereFor }));

import {
  CAMPAIGN_PHASE_FILTERS,
  CAMPAIGNS_PER_PAGE,
  ENTRIES_PER_PAGE,
  loadYearEndOverviewTx,
} from '../year-end-overview';
import { campaignSubmissionPhase, formAnswerProgress } from '../dashboard-policy';
import { freezeFormSchema } from '@/server/forms/schema-snapshot';

type Condition = Record<string, unknown>;

const AT = new Date('2026-10-07T08:00:00Z');
function stored(filled: number, total: number, requiredFilled: number, requiredTotal: number) {
  return {
    answerProgressAt: AT,
    answerProgressFilled: filled,
    answerProgressTotal: total,
    answerProgressRequiredFilled: requiredFilled,
    answerProgressRequiredTotal: requiredTotal,
  };
}
const NOT_STORED = {
  answerProgressAt: null,
  answerProgressFilled: null,
  answerProgressTotal: null,
  answerProgressRequiredFilled: null,
  answerProgressRequiredTotal: null,
};

/** Minimaler Auswerter für die in CAMPAIGN_PHASE_FILTERS genutzten Prisma-Operatoren. */
function matches(value: unknown, condition: unknown): boolean {
  if (condition === null) return value === null;
  if (typeof condition !== 'object') return value === condition;
  const c = condition as Condition;
  if ('not' in c) return c.not === null ? value !== null : value !== c.not;
  if ('notIn' in c) return !(c.notIn as unknown[]).includes(value);
  return Object.entries(c).every(([key, sub]) => matches((value as Condition)[key], sub));
}

const SUBMISSION_STATUSES = ['PENDING', 'DRAFT', 'SUBMITTED', 'REVIEWED'];
const REQUEST_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESPONDED', 'CLOSED', 'CANCELLED'];

describe('CAMPAIGN_PHASE_FILTERS', () => {
  it('ordnet jede Kombination genau der Phase von campaignSubmissionPhase zu', () => {
    for (const status of SUBMISSION_STATUSES)
      for (const submittedAt of [null, new Date('2026-01-15T10:00:00Z')])
        for (const requestStatus of REQUEST_STATUSES) {
          const entry = { submission: { status, submittedAt }, request: { status: requestStatus } };
          const hits = CAMPAIGN_PHASE_FILTERS.filter(([, where]) => matches(entry, where));
          expect(
            hits.map(([phase]) => phase),
            JSON.stringify(entry),
          ).toEqual([campaignSubmissionPhase({ status, submittedAt }, requestStatus)]);
        }
  });
});

describe('loadYearEndOverviewTx', () => {
  const visible = { OR: [{ vertraulich: false }] };
  let tx: ReturnType<typeof makeTx>;

  function makeTx() {
    return {
      yearEndCampaign: {
        count: vi.fn(async () => 12),
        findMany: vi.fn(async () => [
          { id: 'k1', name: 'A', year: 2026, dueAt: new Date('2026-12-31T00:00:00Z') },
          { id: 'k2', name: 'B', year: 2025, dueAt: new Date('2025-12-31T00:00:00Z') },
        ]),
      },
      yearEndCampaignEntry: {
        groupBy: vi.fn(async ({ where }: { where: { AND: Condition[] } }) =>
          where.AND[2] === CAMPAIGN_PHASE_FILTERS[2]![1]
            ? [{ campaignId: 'k1', _count: { _all: 120 } }]
            : [],
        ),
        findMany: vi.fn(async ({ where }: { where: { AND: Array<{ campaignId?: string }> } }) =>
          where.AND[0]!.campaignId === 'k1'
            ? [{ id: 'e1', submissionId: 's1', requestId: 'r1', client: { name: 'Muster' } }]
            : [],
        ),
      },
      formSubmission: {
        findMany: vi.fn(
          async ({
            select,
          }: {
            select: Record<string, unknown>;
          }): Promise<Array<Record<string, unknown>>> =>
            select['answers'] ? [] : [{ id: 's1', status: 'SUBMITTED', ...stored(1, 1, 1, 1) }],
        ),
      },
      request: { findMany: vi.fn(async () => [{ id: 'r1', status: 'OPEN' }]) },
      formTemplate: { findMany: vi.fn(async () => []) },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    m.accessibleClientsWhereFor.mockResolvedValue(visible);
    tx = makeTx();
  });

  it('lädt eine Kampagnenseite, Phasen per groupBy und nur die gezeigten Einreichungen', async () => {
    const data = await loadYearEndOverviewTx(tx as unknown as TxClient, {} as never, {
      page: 2,
      campaignId: 'k1',
      entryPage: 3,
    });

    expect(tx.yearEndCampaign.findMany).toHaveBeenCalledWith({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: CAMPAIGNS_PER_PAGE,
      take: CAMPAIGNS_PER_PAGE,
      select: { id: true, name: true, year: true, dueAt: true },
    });
    const clientVisibility = {
      client: { AND: [visible, { allowActive: true, mandateEndedAt: null }] },
    };
    expect(tx.yearEndCampaignEntry.groupBy).toHaveBeenCalledTimes(CAMPAIGN_PHASE_FILTERS.length);
    expect(tx.yearEndCampaignEntry.groupBy).toHaveBeenCalledWith({
      by: ['campaignId'],
      where: {
        AND: [
          { campaignId: { in: ['k1', 'k2'] } },
          clientVisibility,
          CAMPAIGN_PHASE_FILTERS[0]![1],
        ],
      },
      _count: { _all: true },
    });
    expect(data.phaseCounts.get('k1')).toMatchObject({ SUBMITTED: 120, PENDING: 0 });
    // Nur k1 blättert (120 Einträge → Seite 3 von 3), k2 bleibt auf Seite 1.
    expect(tx.yearEndCampaignEntry.findMany).toHaveBeenNthCalledWith(1, {
      where: { AND: [{ campaignId: 'k1' }, clientVisibility] },
      orderBy: [{ client: { name: 'asc' } }, { id: 'asc' }],
      skip: 2 * ENTRIES_PER_PAGE,
      take: ENTRIES_PER_PAGE,
      select: {
        id: true,
        submissionId: true,
        requestId: true,
        client: { select: { name: true } },
      },
    });
    expect(tx.yearEndCampaignEntry.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ skip: 0 }),
    );
    expect(data.entryPages).toEqual(
      new Map([
        ['k1', 3],
        ['k2', 1],
      ]),
    );
    // Nur die gezeigten Einreichungen, ohne Schema und Antworten (JSON).
    expect(tx.formSubmission.findMany).toHaveBeenCalledTimes(1);
    expect(tx.formSubmission.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['s1'] } },
      select: {
        id: true,
        status: true,
        submittedAt: true,
        reviewedAt: true,
        updatedAt: true,
        answerProgressAt: true,
        answerProgressFilled: true,
        answerProgressTotal: true,
        answerProgressRequiredFilled: true,
        answerProgressRequiredTotal: true,
      },
    });
    expect(data.submissions.get('s1')).toMatchObject({ status: 'SUBMITTED' });
    expect(data.progress.get('s1')).toEqual({
      filled: 1,
      total: 1,
      requiredFilled: 1,
      requiredTotal: 1,
      percent: 100,
    });
    expect(data.requestStatus.get('r1')).toBe('OPEN');
    expect(data.page).toBe(2);
  });

  it('begrenzt Seitenzahlen auf den vorhandenen Bestand', async () => {
    const data = await loadYearEndOverviewTx(tx as unknown as TxClient, {} as never, {
      page: 99,
      campaignId: 'k1',
      entryPage: 99,
    });

    expect(data.page).toBe(Math.ceil(12 / CAMPAIGNS_PER_PAGE));
    expect(data.entryPages.get('k1')).toBe(Math.ceil(120 / ENTRIES_PER_PAGE));
  });

  it('liest gespeicherten Fortschritt und rechnet nur ohne gespeicherten Wert selbst', async () => {
    const snapshot = freezeFormSchema({
      name: 'Checkliste',
      description: null,
      introMd: null,
      fields: ['a', 'b'].map((key) => ({
        id: `field-${key}`,
        key,
        label: key,
        type: 'TEXT' as const,
        required: key === 'a',
        options: null,
        helpText: null,
        defaultValue: null,
        minValue: null,
        maxValue: null,
      })),
    });
    tx.yearEndCampaignEntry.findMany.mockImplementation(async ({ where }) =>
      where.AND[0]!.campaignId === 'k1'
        ? ['s1', 's2', 's3'].map((submissionId, i) => ({
            id: `e${i}`,
            submissionId,
            requestId: `r${i}`,
            client: { name: `Mandant ${i}` },
          }))
        : [],
    );
    tx.formSubmission.findMany.mockImplementation(async ({ select }) =>
      select['answers']
        ? [{ id: 's2', schemaSnapshot: snapshot, answers: { b: 'x' } }]
        : [
            { id: 's1', status: 'SUBMITTED', ...stored(2, 2, 1, 1) },
            { id: 's2', status: 'DRAFT', ...NOT_STORED },
            // Gespeichert als „nicht berechenbar“: keine Neuberechnung.
            { id: 's3', status: 'PENDING', ...NOT_STORED, answerProgressAt: AT },
          ],
    );

    const data = await loadYearEndOverviewTx(tx as unknown as TxClient, {} as never, {
      page: 1,
      campaignId: 'k1',
      entryPage: 1,
    });

    expect(tx.formSubmission.findMany).toHaveBeenCalledTimes(2);
    expect(tx.formSubmission.findMany).toHaveBeenLastCalledWith({
      where: { id: { in: ['s2'] } },
      select: { id: true, schemaSnapshot: true, answers: true },
    });
    expect(data.progress).toEqual(
      new Map([
        ['s1', { filled: 2, total: 2, requiredFilled: 1, requiredTotal: 1, percent: 100 }],
        ['s2', formAnswerProgress(snapshot, { b: 'x' })],
        ['s3', null],
      ]),
    );
    expect(data.progress.get('s2')).toMatchObject({ filled: 1, total: 2, requiredFilled: 0 });
  });
});
