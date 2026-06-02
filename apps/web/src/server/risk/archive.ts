// =============================================================================
// Revisionssichere Archivierung einer Subsumtion (GoBD / § 147 AO).
//
// Erzeugt einen self-contained Snapshot (Sachverhalt + ALLE Markierungen mit
// Governance/Normketten + Metadaten + Hash) als gzip-JSON im GoBD-Bucket mit
// Object-Lock COMPLIANCE (10 J., unveränderlich). Das ist die Langzeit-
// Aufbewahrung: Sachverhalt + Normketten liegen damit im Cold Storage, der
// Snapshot ist selbst hash-verankert (audit_log). Die Live-Daten bleiben in
// Postgres abfragbar, aber die Analyse wird schreibgeschützt (Mutationen
// werden über die Guards abgelehnt).
// =============================================================================

import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { withTenantContext, type TenantContext } from '@taxtronik/db';
import { getBucketForTier, gobdRetentionUntil, putObjectBytes } from '@taxtronik/storage';
import { evidenceService } from '@/server/container';

export class AlreadyArchivedError extends Error {
  constructor() {
    super('Diese Subsumtion ist bereits archiviert.');
    this.name = 'AlreadyArchivedError';
  }
}

function archiveKeyFor(tenantId: string, analysisId: string): string {
  return `risk-archive/${tenantId}/${analysisId}.json.gz`;
}

export async function archiveAnalysis(
  ctx: TenantContext,
  analysisId: string,
): Promise<{ bucket: string; key: string; snapshotHash: string }> {
  const a = await withTenantContext(ctx, async (tx) => {
    const found = await tx.riskAnalysis.findUnique({
      where: { id: analysisId },
      include: {
        markings: { orderBy: [{ start: 'asc' }, { end: 'asc' }] },
        client: { select: { name: true } },
      },
    });
    if (!found) throw new Error('Analyse nicht gefunden.');
    if (found.archivedAt) throw new AlreadyArchivedError();
    return found;
  });

  // Self-contained Snapshot — alles, was die Subsumtion ausmacht.
  const payload = {
    schemaVersion: 1,
    archivedAt: new Date().toISOString(),
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
      llmEnrichedAt: a.llmEnrichedAt ? a.llmEnrichedAt.toISOString() : null,
      rawResultRef: { bucket: a.rawResultBucket, key: a.rawResultKey },
    },
    sourceText: a.sourceText,
    markings: a.markings.map((m) => ({
      ...m,
      createdAt: m.createdAt.toISOString(),
      updatedAt: m.updatedAt.toISOString(),
    })),
  };
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const snapshotHash = createHash('sha256').update(json).digest('hex');
  const gz = gzipSync(json);

  const bucket = getBucketForTier('GOBD');
  const key = archiveKeyFor(ctx.tenantId, analysisId);
  // Object-Lock COMPLIANCE → unveränderlich bis gobdRetentionUntil (10 J.).
  await putObjectBytes(bucket, key, gz, { contentType: 'application/gzip', retainUntil: gobdRetentionUntil() });

  await withTenantContext(ctx, async (tx) => {
    await tx.riskAnalysis.update({
      where: { id: analysisId },
      data: { archivedAt: new Date(), archiveBucket: bucket, archiveKey: key },
    });
    await evidenceService.record(tx, {
      tenantId: ctx.tenantId,
      actorType: 'STAFF',
      actorId: ctx.actorId,
      action: 'risk.analysis.archived',
      resourceType: 'risk_analysis',
      resourceId: analysisId,
      after: {
        archiveBucket: bucket,
        archiveKey: key,
        snapshotHash,
        markingCount: a.markings.length,
        textHash: a.textHash,
      },
    });
  });

  return { bucket, key, snapshotHash };
}
