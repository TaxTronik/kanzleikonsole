import { withTenantContext, type TenantContext } from '@taxtronik/db';
import { resolveNotificationsTx } from '@taxtronik/db/notification';
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
    if (archived) {
      await resolveNotificationsTx(tx, {
        tenantId: ctx.tenantId,
        resources: [{ resourceType: 'risk_research_result', resourceId: resultId }],
      });
    }
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

/**
 * Rechercheergebnis als geprüft-und-verworfen kennzeichnen.
 *
 * `VERWORFEN` gibt es im Schema seit jeher, wurde aber von keiner Aktion
 * gesetzt — und die Analyse-Seite bildete es beim Laden auf `NEU` zurück. Ein
 * unbrauchbares Ergebnis tauchte damit dauerhaft als „neu" auf und liess sich
 * nur noch löschen. Verwerfen ist die fachliche Alternative zum Löschen: die
 * Prüfentscheidung bleibt nachvollziehbar erhalten.
 */
export async function setResearchResultVerworfen(
  ctx: TenantContext,
  resultId: string,
): Promise<void> {
  await withTenantContext(ctx, async (tx) => {
    const result = await tx.riskResearchResult.findUnique({
      where: { id: resultId },
      select: { id: true, title: true, status: true, markingId: true },
    });
    if (!result) throw new ActionError('Rechercheergebnis nicht gefunden.');
    if (result.status === 'VERWORFEN') return;

    await tx.riskResearchResult.update({
      where: { id: resultId },
      data: { status: 'VERWORFEN' },
    });
    await resolveNotificationsTx(tx, {
      tenantId: ctx.tenantId,
      resources: [{ resourceType: 'risk_research_result', resourceId: resultId }],
    });
    await evidenceService.record(tx, {
      tenantId: ctx.tenantId,
      actorType: 'STAFF',
      actorId: ctx.actorId,
      action: 'risk.research.verworfen',
      resourceType: 'risk_research_result',
      resourceId: resultId,
      before: { status: result.status, title: result.title },
      after: { status: 'VERWORFEN', markingId: result.markingId },
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
    await resolveNotificationsTx(tx, {
      tenantId: ctx.tenantId,
      resources: [{ resourceType: 'risk_research_result', resourceId: resultId }],
    });

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
