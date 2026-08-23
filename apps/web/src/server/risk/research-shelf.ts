import type { TenantContext, TxClient } from '@taxtronik/db';
import { withTenantContext } from '@taxtronik/db';
import { commitBytesWithTier } from '@taxtronik/storage';
import { ActionError } from '@/server/actions/action-error';
import { evidenceService } from '@/server/container';
import { createDocumentWithVersion } from '@/server/documents/upload-helpers';
import { compensateStorageCommit } from '@/server/documents/storage-compensation';

interface LockedResearchResult {
  id: string;
  title: string | null;
  body: string;
  requestTitle: string | null;
  shelfDocumentId: string | null;
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
      research_result.shelf_document_id AS "shelfDocumentId"
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
  // Phase 1 (kurze Tx): sperren, Idempotenz und GwG-Schranke pruefen, Nutzlast
  // lesen. Der Object-Store-Schreibvorgang lag frueher INNERHALB dieser Tx —
  // mit gehaltenem `FOR UPDATE` ueber einen S3-Roundtrip hinweg. Bei langsamem
  // Store lief die Tx in ihr 15-s-Limit, und ein Rollback liess das bereits
  // geschriebene Objekt verwaist zurueck. `invoicing/archive.ts` macht es
  // deshalb schon laenger andersherum: erst committen, dann kurz schreiben.
  const prepared = await withTenantContext(ctx, async (tx) => {
    const result = await lockResearchResult(tx, ctx.tenantId, input.resultId);
    if (!result) throw new ActionError('Ergebnis nicht gefunden.');

    if (result.shelfDocumentId) {
      return { alreadySaved: true as const, documentId: result.shelfDocumentId };
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

    return {
      alreadySaved: false as const,
      title: (result.title || result.requestTitle || 'Rechercheergebnis').slice(0, 180),
      body: result.body,
    };
  });

  if (prepared.alreadySaved) {
    return { documentId: prepared.documentId, alreadySaved: true };
  }

  const { title, body } = prepared;
  const commit = await commitBytesWithTier({
    fileData: Buffer.from(body, 'utf8'),
    tier: 'NONE',
    tenantId: ctx.tenantId,
    skipScan: true,
  });

  // Phase 2 (kurze Tx): erneut sperren und Idempotenz ERNEUT pruefen. Zwischen
  // den beiden Transaktionen ist der Zeilen-Lock frei — ein paralleler Klick
  // koennte inzwischen abgelegt haben. Dann gewinnt der andere Lauf, und unser
  // gerade geschriebenes Objekt bleibt ungenutzt (selten, und deutlich
  // harmloser als ein Lock ueber einen Netz-Roundtrip).
  try {
    const result = await withTenantContext(ctx, async (tx) => {
      const again = await lockResearchResult(tx, ctx.tenantId, input.resultId);
      if (!again) throw new ActionError('Ergebnis nicht gefunden.');
      if (again.shelfDocumentId) {
        return { documentId: again.shelfDocumentId, alreadySaved: true };
      }

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
      await tx.riskResearchResult.update({
        where: { id: input.resultId },
        data: { shelfDocumentId: document.id },
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

    if (result.alreadySaved) {
      await compensateStorageCommit({
        tenantId: ctx.tenantId,
        source: 'risk.research.shelf_race',
        commit,
        cause: new Error('Concurrent shelf save won before database commit.'),
      });
    }
    return result;
  } catch (error) {
    await compensateStorageCommit({
      tenantId: ctx.tenantId,
      source: 'risk.research.shelf',
      commit,
      cause: error,
    });
    throw error;
  }
}
