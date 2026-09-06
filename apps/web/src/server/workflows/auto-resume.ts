// =============================================================================
// Lazy-Resume pausierter Workflow-Instanzen.
//
// Bewusst KEIN 'use server': Diese Funktion nimmt tenantId/staffId als
// Argumente und ist nur für den Aufruf aus bereits autorisierten
// Server-Komponenten (Page-Load) gedacht. Läge sie in einer 'use server'-
// Datei, wäre sie ein vom Client aufrufbarer POST-Endpunkt, der die
// übergebene tenantId ungeprüft in den RLS-Kontext übernähme — ein
// Cross-Tenant-Schreibprimitiv. Der Aufrufer (workflows/page.tsx) leitet
// tenantId/staffId ausschließlich aus der geprüften Session ab.
// =============================================================================

import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';

/**
 * Setzt alle pausierten Instanzen, deren `pausedUntil ≤ now`, auf ACTIVE.
 * Wird beim Page-Load der Workflow-Sichten aufgerufen — kein Worker nötig.
 */
export async function autoResumePausedWorkflows(tenantId: string, staffId: string): Promise<void> {
  await withTenantContext({ tenantId, actorId: staffId, actorType: 'STAFF' }, async (tx) => {
    const now = new Date();
    const ready = await tx.workflowInstance.findMany({
      where: { status: 'PAUSED', pausedUntil: { not: null, lte: now } },
      select: { id: true },
    });
    if (ready.length === 0) return;
    for (const r of ready) {
      const resumed = await tx.workflowInstance.updateMany({
        where: { id: r.id, status: 'PAUSED', pausedUntil: { not: null, lte: now } },
        data: { status: 'ACTIVE', pausedUntil: null },
      });
      if (resumed.count !== 1) continue;
      const after = await tx.workflowInstance.findUniqueOrThrow({
        where: { id: r.id },
        select: { status: true, completedAt: true },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'SYSTEM',
        actorId: null,
        action: 'workflow.instance.auto_resume',
        resourceType: 'workflow_instance',
        resourceId: r.id,
        after,
      });
    }
  });
}
