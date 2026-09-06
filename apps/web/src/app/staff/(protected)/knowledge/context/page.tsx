import { requireStaffPage } from '@/server/auth/staff-page';
import { assertModuleEnabled } from '@/server/settings/modules';
import { withTenantContext } from '@taxtronik/db';
import { ContextEditor } from './editor';
export default async function ContextPage() {
  const session = await requireStaffPage({ admin: true });
  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  await assertModuleEnabled(ctx, 'knowledgeContext');
  await assertModuleEnabled(ctx, 'knowledge');
  const [steps, templates, articles] = await withTenantContext(ctx, (tx) =>
    Promise.all([
      tx.workflowStep.findMany({
        include: { template: { select: { name: true } } },
        orderBy: { position: 'asc' },
      }),
      tx.requestTemplate.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
      tx.kbArticle.findMany({
        where: { published: true },
        select: { id: true, title: true },
        orderBy: { title: 'asc' },
      }),
    ]),
  );
  return (
    <div className="p-8 max-w-4xl">
      <h1 className="text-2xl font-bold mb-3">Kanzleileitfäden verknüpfen</h1>
      <p className="mb-4">
        Die Auswahl wird beim Start in neue Vorgänge übernommen. Inhalte bleiben kanzleiintern.
      </p>
      <ContextEditor
        articles={articles}
        targets={[
          ...steps.map((s) => ({
            id: s.id,
            type: 'STEP' as const,
            label: `Workflow ${s.template.name}: ${s.title}`,
            articleIds: s.wikiArticleIds,
          })),
          ...templates.map((t) => ({
            id: t.id,
            type: 'TEMPLATE' as const,
            label: `Anforderung: ${t.name}`,
            articleIds: t.wikiArticleIds,
          })),
        ]}
      />
    </div>
  );
}
