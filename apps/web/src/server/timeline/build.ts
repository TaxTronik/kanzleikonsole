// Merge bounded candidates from domain records, within the existing tenant context.
// Audit-log reads are intentionally not part of this activity timeline.
import type { TenantContext } from '@taxtronik/db';
import { withTenantContext } from '@taxtronik/db';
import type { Prisma } from '@prisma/client';
import { canStaffWriteClientTx } from '@/server/auth/rbac';
import { loadTimelineRecords, type TimelineRecords } from './records';
import { projectTimelineEvents } from './events';
import type { TimelineEvent, TimelineOptions } from './types';

export type { TimelineEventKind, TimelineEvent, TimelineOptions } from './types';

export async function buildClientTimeline(
  ctx: TenantContext,
  options: TimelineOptions,
): Promise<TimelineEvent[]> {
  const { clientId, limit = 100, before } = options;
  return withTenantContext(ctx, async (tx) => {
    const records = await loadTimelineRecords(tx, clientId, limit, before);
    const titleVisible = await visibleRiskTitles(tx, ctx, clientId, records.riskAnalyses);
    return (
      projectTimelineEvents(records, clientId, titleVisible)
        // A candidate loaded for one timestamp can have other, later events.
        .filter((event) => !before || event.occurredAt < before)
        .sort(compareEvents)
        .slice(0, limit)
    );
  });
}

function compareEvents(a: TimelineEvent, b: TimelineEvent): number {
  return (
    b.occurredAt.getTime() - a.occurredAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

async function visibleRiskTitles(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  clientId: string,
  analyses: TimelineRecords['riskAnalyses'],
): Promise<(id: string) => boolean> {
  // ACCESS-TENANT-RLS-001: keep confidential events, but never reveal their
  // titles to unrelated staff. The same checks apply to archive candidates.
  const confidential = analyses
    .filter((analysis) => analysis.vertraulich)
    .map((analysis) => analysis.id);
  if (!confidential.length) return () => true;
  if (ctx.actorId && (await canStaffWriteClientTx(tx, ctx.tenantId, ctx.actorId, clientId)))
    return () => true;
  const visible = new Set(
    analyses.filter((analysis) => !analysis.vertraulich).map((analysis) => analysis.id),
  );
  if (ctx.actorId) {
    const assigned = await tx.riskMarking.findMany({
      where: { analysisId: { in: confidential }, verantwortlichId: ctx.actorId },
      select: { analysisId: true },
    });
    for (const marking of assigned) visible.add(marking.analysisId);
  }
  return (id) => visible.has(id);
}
