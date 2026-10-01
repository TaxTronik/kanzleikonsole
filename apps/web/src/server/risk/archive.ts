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

import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { withTenantContext, type TenantContext } from '@taxtronik/db';
import {
  commitRiskArchiveTx,
  readRiskArchiveStateTx,
  riskArchiveStateHash,
  RiskAnalysisArchivedError,
} from '@taxtronik/db/risk-analysis';
import { getBucketForTier, gobdRetentionUntil, putObjectBytes } from '@taxtronik/storage';
import { evidenceService } from '@/server/container';

export { RiskAnalysisArchivedError as AlreadyArchivedError };

function archiveKeyFor(tenantId: string, analysisId: string): string {
  // Object Lock protects versions, not a mutable key's current version. A losing
  // concurrent attempt must never replace the winner's referenced bytes.
  return `risk-archive/${tenantId}/${analysisId}/${randomUUID()}.json.gz`;
}

export async function archiveAnalysis(
  ctx: TenantContext,
  analysisId: string,
): Promise<{ bucket: string; key: string; snapshotHash: string }> {
  const state = await withTenantContext(ctx, (tx) =>
    readRiskArchiveStateTx(tx, ctx.tenantId, analysisId),
  );
  const expectedStateHash = riskArchiveStateHash(state);
  const archivedAt = new Date();

  // Self-contained Snapshot — alles, was die Subsumtion ausmacht.
  const payload = {
    schemaVersion: 2,
    archivedAt: archivedAt.toISOString(),
    ...state,
  };
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const snapshotHash = createHash('sha256').update(json).digest('hex');
  const gz = gzipSync(json);

  const bucket = getBucketForTier('GOBD');
  const key = archiveKeyFor(ctx.tenantId, analysisId);
  // Object-Lock COMPLIANCE → unveränderlich bis gobdRetentionUntil (10 J.).
  await putObjectBytes(bucket, key, gz, {
    contentType: 'application/gzip',
    retainUntil: gobdRetentionUntil(),
  });

  await withTenantContext(ctx, async (tx) => {
    await commitRiskArchiveTx(tx, {
      tenantId: ctx.tenantId,
      analysisId,
      expectedStateHash,
      archivedAt,
      bucket,
      key,
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
        markingCount: state.markings.length,
        textHash: state.analysis.textHash,
      },
    });
  });

  return { bucket, key, snapshotHash };
}
