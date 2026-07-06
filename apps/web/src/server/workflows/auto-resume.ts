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
  await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const ready = await tx.workflowInstance.findMany({
        where: { status: 'PAUSED', pausedUntil: { not: null, lte: new Date() } },
        select: { id: true },
      });
      if (ready.length === 0) return;
      await tx.workflowInstance.updateMany({
        where: { id: { in: ready.map((r) => r.id) } },
        data: { status: 'ACTIVE', pausedUntil: null },
      });
      for (const r of ready) {
        await evidenceService.record(tx, {
          tenantId, actorType: 'SYSTEM', actorId: null,
          action: 'workflow.instance.auto_resume',
          resourceType: 'workflow_instance',
          resourceId: r.id,
          after: { status: 'ACTIVE' },
        });
      }
    },
  );
}
