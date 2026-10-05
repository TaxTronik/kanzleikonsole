// =============================================================================
// Jahreswechsel-Übersicht (P-19): seitenweise statt alles auf einmal.
//
// Vorher lud die Seite ohne take alle Kampagnen, alle sichtbaren Einträge und
// deren Formular-Einreichungen samt JSON (eingefrorenes Schema + Antworten) und
// filterte die Einträge im Render je Kampagne. Jetzt:
//   - Kampagnen seitenweise (CAMPAIGNS_PER_PAGE, neueste zuerst),
//   - Statusverteilung je Kampagne per groupBy in der Datenbank,
//   - Einträge seitenweise je Kampagne (ENTRIES_PER_PAGE); nur für diese
//     Einträge werden Einreichung und Anforderungsstatus geladen,
//   - alle Zuordnungen im Render über Maps.
// Die Phasen entsprechen exakt campaignSubmissionPhase (YEAR-END-CAMPAIGN-001).
// =============================================================================

import type { Prisma } from '@prisma/client';
import type { TxClient } from '@taxtronik/db';
import { accessibleClientsWhereFor } from '@/server/auth/rbac';
import type { StaffSession } from '@/server/auth/staff';

export const CAMPAIGNS_PER_PAGE = 5;
export const ENTRIES_PER_PAGE = 50;

export type CampaignPhase =
  | 'PENDING'
  | 'IN_PROGRESS'
  | 'RETURNED'
  | 'SUBMITTED'
  | 'REVIEWED'
  | 'CLOSED'
  | 'CANCELLED';

const OPEN_REQUEST: Prisma.RequestWhereInput = { status: { notIn: ['CANCELLED', 'CLOSED'] } };
const NOT_CANCELLED: Prisma.RequestWhereInput = { status: { not: 'CANCELLED' } };

/**
 * Datenbankfilter je Phase; zusammen eine Zerlegung aller Einträge in dieselben
 * Klassen wie campaignSubmissionPhase(submission, request.status).
 */
export const CAMPAIGN_PHASE_FILTERS: ReadonlyArray<
  readonly [CampaignPhase, Prisma.YearEndCampaignEntryWhereInput]
> = [
  ['CANCELLED', { request: { status: 'CANCELLED' } }],
  ['REVIEWED', { request: NOT_CANCELLED, submission: { status: 'REVIEWED' } }],
  ['SUBMITTED', { request: NOT_CANCELLED, submission: { status: 'SUBMITTED' } }],
  [
    'CLOSED',
    { request: { status: 'CLOSED' }, submission: { status: { notIn: ['REVIEWED', 'SUBMITTED'] } } },
  ],
  [
    'RETURNED',
    { request: OPEN_REQUEST, submission: { status: 'DRAFT', submittedAt: { not: null } } },
  ],
  ['IN_PROGRESS', { request: OPEN_REQUEST, submission: { status: 'DRAFT', submittedAt: null } }],
  [
    'PENDING',
    {
      request: OPEN_REQUEST,
      submission: { status: { notIn: ['REVIEWED', 'SUBMITTED', 'DRAFT'] } },
    },
  ],
];

export type PhaseCounts = Record<CampaignPhase, number>;

function emptyCounts(): PhaseCounts {
  return {
    PENDING: 0,
    IN_PROGRESS: 0,
    RETURNED: 0,
    SUBMITTED: 0,
    REVIEWED: 0,
    CLOSED: 0,
    CANCELLED: 0,
  };
}

export interface YearEndOverviewQuery {
  /** 1-basierte Kampagnenseite. */
  page: number;
  /** Kampagne, deren Eintragsseite `entryPage` gilt; alle anderen zeigen Seite 1. */
  campaignId?: string;
  entryPage: number;
}

function clampPage(page: number, total: number, perPage: number): number {
  const pages = Math.max(1, Math.ceil(total / perPage));
  return Math.min(Math.max(1, Math.floor(page) || 1), pages);
}

export async function loadYearEndOverviewTx(
  tx: TxClient,
  session: StaffSession,
  query: YearEndOverviewQuery,
) {
  // Sichtbarkeit wie bisher: zugänglich, freigegeben, Mandat nicht beendet.
  const visible: Prisma.YearEndCampaignEntryWhereInput = {
    client: {
      AND: [
        await accessibleClientsWhereFor(tx, session),
        { allowActive: true, mandateEndedAt: null },
      ],
    },
  };
  const campaignCount = await tx.yearEndCampaign.count();
  const page = clampPage(query.page, campaignCount, CAMPAIGNS_PER_PAGE);
  const campaigns = await tx.yearEndCampaign.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip: (page - 1) * CAMPAIGNS_PER_PAGE,
    take: CAMPAIGNS_PER_PAGE,
    select: { id: true, name: true, year: true, dueAt: true },
  });
  const campaignIds = campaigns.map((campaign) => campaign.id);

  const phaseCounts = new Map<string, PhaseCounts>(campaignIds.map((id) => [id, emptyCounts()]));
  if (campaignIds.length > 0) {
    for (const [phase, where] of CAMPAIGN_PHASE_FILTERS) {
      const groups = await tx.yearEndCampaignEntry.groupBy({
        by: ['campaignId'],
        where: { AND: [{ campaignId: { in: campaignIds } }, visible, where] },
        _count: { _all: true },
      });
      for (const group of groups) phaseCounts.get(group.campaignId)![phase] = group._count._all;
    }
  }

  const entryPages = new Map<string, number>();
  const entriesByCampaign = new Map<
    string,
    Array<{ id: string; submissionId: string; requestId: string; client: { name: string } }>
  >();
  for (const campaign of campaigns) {
    const total = Object.values(phaseCounts.get(campaign.id)!).reduce((a, b) => a + b, 0);
    const entryPage = clampPage(
      query.campaignId === campaign.id ? query.entryPage : 1,
      total,
      ENTRIES_PER_PAGE,
    );
    entryPages.set(campaign.id, entryPage);
    entriesByCampaign.set(
      campaign.id,
      await tx.yearEndCampaignEntry.findMany({
        where: { AND: [{ campaignId: campaign.id }, visible] },
        orderBy: [{ client: { name: 'asc' } }, { id: 'asc' }],
        skip: (entryPage - 1) * ENTRIES_PER_PAGE,
        take: ENTRIES_PER_PAGE,
        select: {
          id: true,
          submissionId: true,
          requestId: true,
          client: { select: { name: true } },
        },
      }),
    );
  }
  const shown = [...entriesByCampaign.values()].flat();
  const submissions = await tx.formSubmission.findMany({
    where: { id: { in: shown.map((entry) => entry.submissionId) } },
    select: {
      id: true,
      status: true,
      submittedAt: true,
      reviewedAt: true,
      updatedAt: true,
      schemaSnapshot: true,
      answers: true,
    },
  });
  const requests = await tx.request.findMany({
    where: { id: { in: shown.map((entry) => entry.requestId) } },
    select: { id: true, status: true },
  });
  const templates = await tx.formTemplate.findMany({
    where: { active: true },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  return {
    page,
    campaignCount,
    campaigns,
    phaseCounts,
    entryPages,
    entriesByCampaign,
    submissions: new Map(submissions.map((submission) => [submission.id, submission])),
    requestStatus: new Map(requests.map((request) => [request.id, request.status])),
    templates,
  };
}

export type YearEndOverview = Awaited<ReturnType<typeof loadYearEndOverviewTx>>;
