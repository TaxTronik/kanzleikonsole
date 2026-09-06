import type { Prisma } from '@prisma/client';

/** Each stored event time supplies its own bounded, deterministic candidate page. */
function eventPage(field: string, limit: number, before?: Date) {
  return {
    where: {
      [field]: {
        ...(field === 'createdAt' ? {} : { not: null }),
        ...(before ? { lt: before } : {}),
      },
    },
    orderBy: [{ [field]: 'desc' as const }, { id: 'asc' as const }],
    take: limit,
  };
}

async function loadCandidates<T extends { id: string }>(
  fields: readonly string[],
  limit: number,
  before: Date | undefined,
  find: (page: ReturnType<typeof eventPage>) => PromiseLike<T[]>,
): Promise<T[]> {
  const pages = await Promise.all(fields.map((field) => find(eventPage(field, limit, before))));
  // A record can qualify through several event times; project it only once.
  return [...new Map(pages.flat().map((row) => [row.id, row])).values()];
}

export async function loadTimelineRecords(
  tx: Prisma.TransactionClient,
  clientId: string,
  limit: number,
  before?: Date,
) {
  const created = eventPage('createdAt', limit, before);
  const completed = eventPage('completedAt', limit, before);
  const done = eventPage('doneAt', limit, before);
  const [
    docs,
    requests,
    responses,
    phoneNotes,
    invoices,
    gwgChecks,
    poas,
    taxNotices,
    taxDeadlines,
    workflowItems,
    riskAnalyses,
  ] = await Promise.all([
    tx.document.findMany({
      ...created,
      where: { clientId, ...created.where },
      select: { id: true, title: true, classification: true, createdAt: true },
    }),
    loadCandidates(['createdAt', 'closedAt'], limit, before, (page) =>
      tx.request.findMany({
        ...page,
        where: { clientId, ...page.where },
        select: { id: true, title: true, priority: true, createdAt: true, closedAt: true },
      }),
    ),
    tx.requestResponse.findMany({
      ...created,
      where: { request: { clientId }, ...created.where },
      select: {
        id: true,
        requestId: true,
        authorType: true,
        message: true,
        createdAt: true,
        request: { select: { title: true } },
      },
    }),
    tx.phoneNote.findMany({
      ...created,
      where: { clientId, ...created.where },
      select: { id: true, subject: true, callerName: true, createdAt: true },
    }),
    loadCandidates(['createdAt', 'sentAt', 'paidAt'], limit, before, (page) =>
      tx.invoice.findMany({
        ...page,
        where: { clientId, ...page.where },
        select: {
          id: true,
          number: true,
          subject: true,
          totalAmount: true,
          createdAt: true,
          sentAt: true,
          paidAt: true,
        },
      }),
    ),
    loadCandidates(['createdAt', 'verifiedAt'], limit, before, (page) =>
      tx.gwgCheck.findMany({
        ...page,
        where: { clientId, ...page.where },
        select: {
          id: true,
          status: true,
          riskLevel: true,
          createdAt: true,
          verifiedAt: true,
          rejectedReason: true,
        },
      }),
    ),
    loadCandidates(['createdAt', 'signedAt', 'revokedAt'], limit, before, (page) =>
      tx.powerOfAttorney.findMany({
        ...page,
        where: { clientId, ...page.where },
        select: {
          id: true,
          subject: true,
          signerName: true,
          createdAt: true,
          signedAt: true,
          revokedAt: true,
          revokedReason: true,
        },
      }),
    ),
    tx.taxNotice.findMany({
      ...created,
      where: { clientId, ...created.where },
      select: {
        id: true,
        kind: true,
        period: true,
        createdAt: true,
        assessedAmount: true,
        expectedAmount: true,
      },
    }),
    tx.taxDeadline.findMany({
      ...completed,
      where: { clientId, status: 'DONE', ...completed.where },
      select: { id: true, kind: true, period: true, completedAt: true },
    }),
    tx.workflowItem.findMany({
      ...done,
      where: { instance: { clientId }, ...done.where },
      select: {
        id: true,
        title: true,
        doneAt: true,
        instance: { select: { id: true, name: true } },
      },
    }),
    loadCandidates(['createdAt', 'archivedAt'], limit, before, (page) =>
      tx.riskAnalysis.findMany({
        ...page,
        where: { clientId, ...page.where },
        select: {
          id: true,
          title: true,
          textHash: true,
          katalogVersion: true,
          vertraulich: true,
          createdAt: true,
          archivedAt: true,
          _count: { select: { markings: true } },
        },
      }),
    ),
  ]);
  return {
    docs,
    requests,
    responses,
    phoneNotes,
    invoices,
    gwgChecks,
    poas,
    taxNotices,
    taxDeadlines,
    workflowItems,
    riskAnalyses,
  };
}

export type TimelineRecords = Awaited<ReturnType<typeof loadTimelineRecords>>;
