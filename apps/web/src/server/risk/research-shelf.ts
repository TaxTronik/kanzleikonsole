import type { TenantContext, TxClient } from '@taxtronik/db';
import { withTenantContext } from '@taxtronik/db';
import { commitBytesWithTier } from '@taxtronik/storage';
import { ActionError } from '@/server/actions/action-error';
import { evidenceService } from '@/server/container';
import { createDocumentWithVersion } from '@/server/documents/upload-helpers';

interface LockedResearchResult {
  id: string;
  title: string | null;
  body: string;
  requestTitle: string | null;
  shelfDocumentId: string | null;
  savedToShelfAt: Date | null;
}

export interface SaveResearchResultToShelfInput {
  resultId: string;
  clientId: string;
  analysisId: string | null;
  staffId: string;
}

export interface SaveResearchResultToShelfResult {
  documentId: string | null;
  alreadySaved: boolean;
}

async function lockResearchResult(
  tx: TxClient,
  tenantId: string,
  resultId: string,
): Promise<LockedResearchResult | null> {
  const rows = await tx.$queryRaw<LockedResearchResult[]>`
    SELECT
      research_result.id,
      research_result.title,
      research_result.body,
      request.title AS "requestTitle",
      research_result.shelf_document_id AS "shelfDocumentId",
      research_result.saved_to_shelf_at AS "savedToShelfAt"
    FROM risk_research_result research_result
    LEFT JOIN risk_research_request request
      ON request.id = research_result.research_request_id
    WHERE research_result.id = ${resultId}::uuid
      AND research_result.tenant_id = ${tenantId}::uuid
    FOR UPDATE OF research_result
  `;
  return rows[0] ?? null;
}

export async function saveResearchResultToShelf(
  ctx: TenantContext,
  input: SaveResearchResultToShelfInput,
): Promise<SaveResearchResultToShelfResult> {
  return withTenantContext(ctx, async (tx) => {
    const result = await lockResearchResult(tx, ctx.tenantId, input.resultId);
    if (!result) throw new ActionError('Ergebnis nicht gefunden.');

    if (result.savedToShelfAt || result.shelfDocumentId) {
      return { documentId: result.shelfDocumentId, alreadySaved: true };
    }

    const client = await tx.client.findUnique({
      where: { id: input.clientId },
      select: { allowActive: true },
    });
    if (!client?.allowActive) {
      throw new ActionError(
        'Der Mandant ist nicht aktiv (GwG-Prüfung ausstehend) — Dokumente können erst danach abgelegt werden.',
      );
    }

    const title = (result.title || result.requestTitle || 'Rechercheergebnis').slice(0, 180);
    const commit = await commitBytesWithTier({
      fileData: Buffer.from(result.body, 'utf8'),
      tier: 'NONE',
      tenantId: ctx.tenantId,
      skipScan: true,
    });
    const { document } = await createDocumentWithVersion(tx, {
      documentData: {
        tenantId: ctx.tenantId,
        clientId: input.clientId,
        analysisId: input.analysisId,
        title: title.endsWith('.md') ? title : `${title}.md`,
        classification: 'GENERAL',
        mimeType: 'text/markdown',
      },
      commit,
      createdById: input.staffId,
    });
    const savedToShelfAt = new Date();
    await tx.riskResearchResult.update({
      where: { id: input.resultId },
      data: { shelfDocumentId: document.id, savedToShelfAt },
    });
    await evidenceService.record(tx, {
      tenantId: ctx.tenantId,
      actorType: 'STAFF',
      actorId: input.staffId,
      action: 'risk.research.saved_to_shelf',
      resourceType: 'document',
      resourceId: document.id,
      after: { resultId: input.resultId, analysisId: input.analysisId, title },
    });

    return { documentId: document.id, alreadySaved: false };
  });
}
