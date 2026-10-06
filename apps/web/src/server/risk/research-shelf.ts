import type { TenantContext, TxClient } from '@taxtronik/db';
import { ActionError } from '@/server/actions/action-error';
import { evidenceService } from '@/server/container';
import { createDocumentWithVersion } from '@/server/documents/upload-helpers';
import {
  JournaledUploadError,
  runJournaledUpload,
  uploadFailureCause,
} from '@/server/documents/journaled-upload';

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

/** Vorprüfung: bereits abgelegt — kein Object-Write, das vorhandene Dokument gilt. */
class AlreadyOnShelf extends Error {
  constructor(readonly documentId: string) {
    super('RESEARCH_RESULT_ALREADY_ON_SHELF');
  }
}

interface ShelfCheck {
  /** In der Nachprüfung: inzwischen von einem parallelen Lauf abgelegt. */
  savedDocumentId: string | null;
  title: string;
  body: string;
}

/**
 * Gemeinsame Vor- und Nachprüfung (K-06 / DOC-UPLOAD-JOURNAL-001): Ergebnis
 * sperren, Idempotenz und GwG-Schranke prüfen. Die Nachprüfung übernimmt Titel
 * und Inhalt der Vorprüfung, weil genau diese Bytes geschrieben wurden.
 */
async function checkShelfTx(
  tx: TxClient,
  ctx: TenantContext,
  input: SaveResearchResultToShelfInput,
  pre?: ShelfCheck,
): Promise<ShelfCheck> {
  const result = await lockResearchResult(tx, ctx.tenantId, input.resultId);
  if (!result) throw new ActionError('Ergebnis nicht gefunden.');

  if (result.shelfDocumentId) {
    if (!pre) throw new AlreadyOnShelf(result.shelfDocumentId);
    return { ...pre, savedDocumentId: result.shelfDocumentId };
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
    savedDocumentId: null,
    title: pre?.title ?? (result.title || result.requestTitle || 'Rechercheergebnis').slice(0, 180),
    body: pre?.body ?? result.body,
  };
}

export async function saveResearchResultToShelf(
  ctx: TenantContext,
  input: SaveResearchResultToShelfInput,
): Promise<SaveResearchResultToShelfResult> {
  // Vorprüfung (kurze Tx): sperren, Idempotenz und GwG-Schranke prüfen,
  // Nutzlast lesen. Der Object-Store-Schreibvorgang lag frueher INNERHALB
  // dieser Tx — mit gehaltenem `FOR UPDATE` ueber einen S3-Roundtrip hinweg.
  // Bei langsamem Store lief die Tx in ihr 15-s-Limit, und ein Rollback liess
  // das bereits geschriebene Objekt verwaist zurueck. K-06: Jetzt steht die
  // Speicherabsicht vor dem Write im Journal; die Nachprüfung (kurze Tx) sperrt
  // erneut und prüft die Idempotenz ERNEUT. Zwischen den beiden Transaktionen
  // ist der Zeilen-Lock frei — ein paralleler Klick koennte inzwischen abgelegt
  // haben. Dann gewinnt der andere Lauf, und unsere Absicht bleibt fuer den
  // Cleanup-Worker offen (selten, und deutlich harmloser als ein Lock ueber
  // einen Netz-Roundtrip).
  try {
    const { result } = await runJournaledUpload({
      context: ctx,
      source: 'risk.research.shelf',
      check: (tx: TxClient, _phase: 'pre' | 'post', pre?: ShelfCheck) =>
        checkShelfTx(tx, ctx, input, pre),
      readBytes: async (checked) => Buffer.from(checked.body, 'utf8'),
      storage: () => ({ tier: 'NONE', skipScan: true }),
      commitTx: async (tx, { commit, checked }) => {
        if (checked.savedDocumentId) {
          return { documentId: checked.savedDocumentId, alreadySaved: true };
        }
        const { title } = checked;
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
      },
      referenced: (saved) => !saved.alreadySaved,
    });
    return result;
  } catch (error) {
    if (
      error instanceof JournaledUploadError &&
      error.phase === 'check' &&
      error.cause instanceof AlreadyOnShelf
    ) {
      return { documentId: error.cause.documentId, alreadySaved: true };
    }
    throw uploadFailureCause(error);
  }
}
