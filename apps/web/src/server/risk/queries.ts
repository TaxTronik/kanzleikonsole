// =============================================================================
// Lese-Queries für den Subsumtions-Workspace (tenant-scoped, RLS).
// =============================================================================

import { withTenantContext, type TenantContext } from '@taxtronik/db';

/** Kopfdaten einer Subsumtion für die Mandanten-Liste. */
export async function listAnalyses(ctx: TenantContext, clientId: string) {
  return withTenantContext(ctx, (tx) =>
    tx.riskAnalysis.findMany({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        title: true,
        textHash: true,
        katalogVersion: true,
        engineVersion: true,
        llmEnrichedAt: true,
        createdAt: true,
        createdById: true,
        _count: { select: { markings: true } },
      },
    }),
  );
}

/** Eine Subsumtion samt Sachverhalt + allen Markierungen, oder null. */
export async function loadAnalysis(ctx: TenantContext, analysisId: string) {
  return withTenantContext(ctx, (tx) =>
    tx.riskAnalysis.findUnique({
      where: { id: analysisId },
      include: {
        markings: { orderBy: { start: 'asc' } },
      },
    }),
  );
}
