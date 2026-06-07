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

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Aus dem Object-Store extrahierbare Mandanten-Dokumente (PDF/DOCX/Text). */
export async function listExtractableDocuments(ctx: TenantContext, clientId: string) {
  return withTenantContext(ctx, (tx) =>
    tx.document.findMany({
      where: {
        clientId,
        deletedAt: null,
        OR: [
          { mimeType: 'application/pdf' },
          { mimeType: DOCX_MIME },
          { mimeType: { startsWith: 'text/' } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, title: true, mimeType: true, documentType: { select: { name: true } } },
    }),
  );
}

/** Rechercheergebnisse (von n8n) zu einer Analyse — zugeordnet oder NEU. */
export async function loadResearchResults(ctx: TenantContext, analysisId: string) {
  return withTenantContext(ctx, (tx) =>
    tx.riskResearchResult.findMany({
      where: {
        status: { not: 'VERWORFEN' },
        OR: [{ request: { analysisId } }, { marking: { analysisId } }],
      },
      orderBy: { receivedAt: 'desc' },
      take: 100,
      select: {
        id: true,
        title: true,
        body: true,
        status: true,
        markingId: true,
        source: true,
        receivedAt: true,
      },
    }),
  );
}

/** Gesendete Rechercheaufträge (Outbound an n8n) zu einer Analyse — für den
 *  Recherche-Hub. Lädt NICHT `mapping`/`anonymizedPayload` (sensibel/unnötig);
 *  `marking.begriff` als lesbares Label, `_count.results` für „N Antworten". */
export async function loadResearchRequests(ctx: TenantContext, analysisId: string) {
  return withTenantContext(ctx, (tx) =>
    tx.riskResearchRequest.findMany({
      where: { analysisId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        markingId: true,
        prompt: true,
        includeSachverhalt: true,
        status: true,
        createdAt: true,
        createdById: true,
        marking: { select: { begriff: true } },
        _count: { select: { results: true } },
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
