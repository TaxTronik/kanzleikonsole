'use server';

import { z } from 'zod';
import { withStaff, ActionError } from '@/server/actions/staff-action';
import { assertClientAccessTx } from '@/server/auth/rbac';
import { assertModuleEnabled } from '@/server/settings/modules';
import { evidenceService } from '@/server/container';
import { renderMarkdown } from '@/lib/markdown';

const targetSchema = z.object({
  type: z.enum(['STEP', 'TEMPLATE', 'ITEM', 'REQUEST']),
  id: z.string().uuid(),
});
export async function saveKnowledgeContextAction(input: {
  type: 'STEP' | 'TEMPLATE';
  id: string;
  articleIds: string[];
}) {
  const parsed = targetSchema
    .extend({ type: z.enum(['STEP', 'TEMPLATE']), articleIds: z.array(z.string().uuid()).max(10) })
    .safeParse(input);
  if (!parsed.success) return { ok: false as const, error: 'Ungültige Verknüpfung.' };
  return withStaff(
    async (tx, g) => {
      await assertModuleEnabled(g.ctx, 'knowledge');
      if (input.type === 'STEP') await assertModuleEnabled(g.ctx, 'workflows');
      const articleIds = [...new Set(parsed.data.articleIds)];
      if (
        (await tx.kbArticle.count({ where: { id: { in: articleIds }, published: true } })) !==
        articleIds.length
      )
        throw new ActionError('Nur veröffentlichte Kanzleiartikel können verknüpft werden.');
      if (parsed.data.type === 'STEP')
        await tx.workflowStep.update({
          where: { id: parsed.data.id },
          data: { wikiArticleIds: articleIds },
        });
      else
        await tx.requestTemplate.update({
          where: { id: parsed.data.id },
          data: { wikiArticleIds: articleIds },
        });
      await evidenceService.record(tx, {
        tenantId: g.tenantId,
        actorId: g.staffId,
        actorType: 'STAFF',
        action: 'knowledge.context.updated',
        resourceType: parsed.data.type === 'STEP' ? 'workflow_step' : 'request_template',
        resourceId: parsed.data.id,
        after: { articleIds },
      });
    },
    { module: 'knowledgeContext', requireAdmin: true, revalidate: '/staff/knowledge/context' },
  );
}

export async function loadKnowledgeContextAction(input: { type: 'ITEM' | 'REQUEST'; id: string }) {
  const parsed = targetSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: 'Ungültiger Vorgang.' };
  return withStaff(
    async (tx, g) => {
      await assertModuleEnabled(g.ctx, 'knowledge');
      let articleIds: string[];
      if (input.type === 'ITEM') {
        await assertModuleEnabled(g.ctx, 'workflows');
        const item = await tx.workflowItem.findUnique({
          where: { id: input.id },
          include: { instance: { select: { clientId: true } } },
        });
        if (!item) throw new ActionError('Vorgang nicht gefunden.');
        await assertClientAccessTx(tx, g.session, item.instance.clientId);
        articleIds = item.wikiArticleIds;
      } else {
        const request = await tx.request.findUnique({ where: { id: input.id } });
        if (!request) throw new ActionError('Vorgang nicht gefunden.');
        await assertClientAccessTx(tx, g.session, request.clientId);
        articleIds = request.wikiArticleIds;
      }
      const articles = await tx.kbArticle.findMany({
        where: { id: { in: articleIds }, published: true },
        select: { id: true, title: true, body: true, updatedAt: true },
      });
      return {
        articles: articles.map((a) => ({
          id: a.id,
          title: a.title,
          html: renderMarkdown(a.body),
          updatedAt: a.updatedAt.toISOString(),
        })),
      };
    },
    { module: 'knowledgeContext' },
  );
}
