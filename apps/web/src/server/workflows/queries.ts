// =============================================================================
// Gemeinsamer Lese-Loader für Mandanten-Workflows (tenant-scoped, RLS).
//
// Wird von der Standalone-Seite (clients/[id]/workflows) UND vom Sachverhalt-Tab
// „Aufgaben" (subsumtion) genutzt — eine Quelle für Query + Typ, damit die
// WorkflowSection-Komponente in beiden Kontexten identisch rendert (kein Doppel-
// Code). `analysisId` scopt auf einen Sachverhalt; `mineStaffId` = „nur meine".
// =============================================================================

import { withTenantContext, type TenantContext } from '@taxtronik/db';

export async function loadClientWorkflows(
  ctx: TenantContext,
  opts: { clientId: string; analysisId?: string; mineStaffId?: string },
) {
  return withTenantContext(ctx, async (tx) => {
    const [instances, templates, staffList, formTemplates, requestTemplates, emailTemplates] =
      await Promise.all([
        tx.workflowInstance.findMany({
          where: {
            clientId: opts.clientId,
            ...(opts.analysisId ? { analysisId: opts.analysisId } : {}),
            ...(opts.mineStaffId
              ? {
                  OR: [
                    { startedByStaff: opts.mineStaffId },
                    { items: { some: { assigneeStaffId: opts.mineStaffId, doneAt: null } } },
                  ],
                }
              : {}),
          },
          orderBy: [{ status: 'asc' }, { startedAt: 'desc' }],
          include: {
            members: { select: { staffId: true } },
            items: {
              orderBy: { position: 'asc' },
              include: {
                skill: { select: { label: true, color: true } },
                triggeredRequests: { select: { id: true } },
                comments: {
                  orderBy: { createdAt: 'asc' },
                  select: { id: true, authorName: true, body: true, createdAt: true },
                },
                documents: {
                  orderBy: { createdAt: 'asc' },
                  select: { id: true, title: true, createdAt: true },
                },
              },
            },
          },
        }),
        tx.workflowTemplate.findMany({
          where: { active: true },
          orderBy: { name: 'asc' },
          select: { id: true, name: true, _count: { select: { steps: true } } },
        }),
        tx.staffUser.findMany({
          where: { active: true },
          orderBy: { fullName: 'asc' },
          select: { id: true, fullName: true },
        }),
        tx.formTemplate.findMany({
          where: { active: true },
          orderBy: { name: 'asc' },
          select: { id: true, name: true },
        }),
        tx.requestTemplate.findMany({
          where: { active: true },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          select: { id: true, name: true, category: true },
        }),
        tx.emailTemplate.findMany({
          where: { active: true },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          select: { id: true, name: true, category: true },
        }),
      ]);
    return { instances, templates, staffList, formTemplates, requestTemplates, emailTemplates };
  });
}

export type ClientWorkflowsData = Awaited<ReturnType<typeof loadClientWorkflows>>;
