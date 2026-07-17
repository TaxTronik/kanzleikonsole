import { withTenantContext, type TenantContext } from '@taxtronik/db';
import { ActionError } from '@/server/actions/action-error';
import { evidenceService } from '@/server/container';

export async function setResearchResultArchived(
  ctx: TenantContext,
  resultId: string,
  archived: boolean,
): Promise<void> {
  await withTenantContext(ctx, async (tx) => {
    const result = await tx.riskResearchResult.findUnique({
      where: { id: resultId },
      select: { id: true, title: true, archivedAt: true, researchRequestId: true },
    });
    if (!result) throw new ActionError('Rechercheergebnis nicht gefunden.');

    const isArchived = result.archivedAt != null;
    if (isArchived === archived) return;

    const archivedAt = archived ? new Date() : null;
    await tx.riskResearchResult.update({
      where: { id: resultId },
      data: { archivedAt },
    });
    await evidenceService.record(tx, {
      tenantId: ctx.tenantId,
      actorType: 'STAFF',
      actorId: ctx.actorId,
      action: archived ? 'risk.research.archived' : 'risk.research.restored',
      resourceType: 'risk_research_result',
      resourceId: resultId,
      before: { archivedAt: result.archivedAt, title: result.title },
      after: { archivedAt, researchRequestId: result.researchRequestId },
    });
  });
}

export async function deleteResearchResult(ctx: TenantContext, resultId: string): Promise<void> {
  await withTenantContext(ctx, async (tx) => {
    const result = await tx.riskResearchResult.findUnique({
      where: { id: resultId },
      select: {
        id: true,
        title: true,
        status: true,
        archivedAt: true,
        researchRequestId: true,
        markingId: true,
        shelfDocumentId: true,
      },
    });
    if (!result) throw new ActionError('Rechercheergebnis nicht gefunden.');

    await tx.riskResearchResult.delete({ where: { id: resultId } });
    await evidenceService.record(tx, {
      tenantId: ctx.tenantId,
      actorType: 'STAFF',
      actorId: ctx.actorId,
      action: 'risk.research.deleted',
      resourceType: 'risk_research_result',
      resourceId: resultId,
      before: result,
      after: null,
    });
  });
}
