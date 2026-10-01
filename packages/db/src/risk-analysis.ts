// RISK-ARCHIVE-SNAPSHOT-001: every content writer locks the parent before reading
// markings. The DB triggers enforce the same boundary for raw/nested writes.
import { createHash } from 'node:crypto';
import type { TxClient } from './tenant-context';

export class RiskAnalysisArchivedError extends Error {
  constructor() {
    super('Diese Subsumtion ist archiviert (schreibgeschützt).');
    this.name = 'RiskAnalysisArchivedError';
  }
}

export class RiskAnalysisChangedError extends Error {
  constructor() {
    super('Die Subsumtion wurde zwischenzeitlich geändert. Bitte erneut versuchen.');
    this.name = 'RiskAnalysisChangedError';
  }
}

export async function lockRiskAnalysisTx(tx: TxClient, tenantId: string, analysisId: string) {
  // Canonical order: client -> analysis -> tenant audit lock. In particular,
  // retention holds client FOR UPDATE before redacting contacts (with audit)
  // and risk rows, while delegation inserts a reminder with a client FK.
  const [scope] = await tx.$queryRaw<Array<{ clientId: string | null }>>`
    SELECT client_id AS "clientId" FROM public.risk_analysis
     WHERE id = ${analysisId}::uuid AND tenant_id = ${tenantId}::uuid`;
  if (!scope) return null;
  if (scope.clientId) {
    const clients = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM public.client WHERE id = ${scope.clientId}::uuid
       AND tenant_id = ${tenantId}::uuid FOR KEY SHARE`;
    if (clients.length !== 1) throw new Error('Mandant nicht gefunden.');
  }
  const [row] = await tx.$queryRaw<
    Array<{
      id: string;
      clientId: string | null;
      sourceText: string;
      archivedAt: Date | null;
      vertraulich: boolean;
    }>
  >`SELECT id, client_id AS "clientId", source_text AS "sourceText", archived_at AS "archivedAt", vertraulich
      FROM public.risk_analysis
     WHERE id = ${analysisId}::uuid AND tenant_id = ${tenantId}::uuid FOR UPDATE`;
  // A raw caller may have moved the unarchived analysis during the first read.
  // Never acquire a different client lock after the analysis lock.
  if (row && row.clientId !== scope.clientId) throw new RiskAnalysisChangedError();
  return row ?? null;
}

/** Called after the client's FOR UPDATE lock, before the first audit event. */
export async function lockClientRiskAnalysesTx(tx: TxClient, clientId: string) {
  await tx.$queryRaw`SELECT id FROM public.risk_analysis
    WHERE client_id = ${clientId}::uuid ORDER BY id FOR UPDATE`;
}

export async function requireWritableRiskAnalysisTx(
  tx: TxClient,
  tenantId: string,
  analysisId: string,
  expectedSourceText?: string,
) {
  const row = await lockRiskAnalysisTx(tx, tenantId, analysisId);
  if (!row) throw new Error('Analyse nicht gefunden.');
  if (row.archivedAt) throw new RiskAnalysisArchivedError();
  if (expectedSourceText !== undefined && row.sourceText !== expectedSourceText) {
    throw new RiskAnalysisChangedError();
  }
  return row;
}

export async function requireWritableRiskMarkingTx(
  tx: TxClient,
  tenantId: string,
  markingId: string,
) {
  // Do not lock the child first: all normal writers share parent -> child order.
  const [marking] = await tx.$queryRaw<Array<{ analysisId: string }>>`
    SELECT analysis_id AS "analysisId" FROM public.risk_marking
     WHERE id = ${markingId}::uuid AND tenant_id = ${tenantId}::uuid`;
  if (!marking) throw new Error('Markierung nicht gefunden.');
  await requireWritableRiskAnalysisTx(tx, tenantId, marking.analysisId);
  return marking.analysisId;
}

/** Read under the parent lock; marking triggers share it, including inserts. */
export async function readRiskArchiveStateTx(tx: TxClient, tenantId: string, analysisId: string) {
  await requireWritableRiskAnalysisTx(tx, tenantId, analysisId);
  const a = await tx.riskAnalysis.findFirst({
    where: { id: analysisId, tenantId },
    include: {
      markings: { orderBy: [{ start: 'asc' }, { end: 'asc' }, { id: 'asc' }] },
      client: { select: { name: true } },
    },
  });
  if (!a) throw new Error('Analyse nicht gefunden.');
  return {
    analysis: {
      id: a.id,
      title: a.title,
      clientId: a.clientId,
      clientName: a.client?.name ?? null,
      documentId: a.documentId,
      textHash: a.textHash,
      katalogVersion: a.katalogVersion,
      engineVersion: a.engineVersion,
      createdAt: a.createdAt.toISOString(),
      createdById: a.createdById,
      llmEnrichedAt: a.llmEnrichedAt?.toISOString() ?? null,
      rawResultRef: { bucket: a.rawResultBucket, key: a.rawResultKey },
    },
    sourceText: a.sourceText,
    sourceDoc: a.sourceDoc,
    markings: a.markings.map((m) => ({
      ...m,
      createdAt: m.createdAt.toISOString(),
      updatedAt: m.updatedAt.toISOString(),
    })),
  };
}

export function riskArchiveStateHash(state: Awaited<ReturnType<typeof readRiskArchiveStateTx>>) {
  return createHash('sha256').update(JSON.stringify(state), 'utf8').digest('hex');
}

/** Commit only the exact uploaded state, with the lock held through audit/commit. */
export async function commitRiskArchiveTx(
  tx: TxClient,
  input: {
    tenantId: string;
    analysisId: string;
    expectedStateHash: string;
    archivedAt: Date;
    bucket: string;
    key: string;
  },
) {
  const state = await readRiskArchiveStateTx(tx, input.tenantId, input.analysisId);
  if (riskArchiveStateHash(state) !== input.expectedStateHash) {
    throw new RiskAnalysisChangedError();
  }
  await tx.riskAnalysis.update({
    where: { id: input.analysisId },
    data: { archivedAt: input.archivedAt, archiveBucket: input.bucket, archiveKey: input.key },
  });
}
