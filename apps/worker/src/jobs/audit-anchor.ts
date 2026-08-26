// =============================================================================
// Non-blocking rolling RFC-3161 anchors.
//
// The worker only reads committed audit rows. The TSA HTTP request never runs
// inside a business transaction and never holds the local audit advisory lock,
// so writers continue appending while an older prefix is being timestamped.
// =============================================================================

import { Worker } from 'bullmq';
import { env } from '@taxtronik/config';
import { JOB_QUEUES } from '@taxtronik/config/job-queues';
import { readTenantSettingValue } from '@taxtronik/db/tenant-settings';
import {
  AUDIT_ANCHOR_STATUS_SETTING_KEY,
  EvidenceService,
  type PersistedAnchorStatus,
} from '@taxtronik/evidence';
import { connection, type AuditAnchorJob } from '../queues';
import { prismaOwner } from '../prisma-owner';
import { timestampPortFor } from '../tsa-port';
import { withWorkerTenantContext } from '../tenant-context';
import { log } from '../logger';

const TENANT_BATCH = 50;
const PARALLEL_TENANTS = 4;
const BASE_RETRY_MS = 5_000;
const MAX_RETRY_MS = 5 * 60_000;
const REQUIRE_TRUST_ANCHOR =
  env.NODE_ENV === 'production' || process.env['EVIDENCE_REQUIRE_TSA'] === 'true';

interface PendingTenant {
  tenant_id: string;
  critical: boolean;
  oldest_pending_at: Date;
}

async function pendingTenantIds(): Promise<string[]> {
  const rows = await prismaOwner.$queryRaw<PendingTenant[]>`
    WITH last_anchor AS (
      SELECT DISTINCT ON (tenant_id) tenant_id, top_audit_id
      FROM audit_anchor
      ORDER BY tenant_id, id DESC
    )
    SELECT
      t.id AS tenant_id,
      EXISTS (
        SELECT 1
        FROM audit_log critical_log
        WHERE critical_log.tenant_id = t.id
          AND critical_log.id > COALESCE(a.top_audit_id, 0)
          AND (
            critical_log.action LIKE 'invoice.%'
            OR critical_log.action LIKE 'gwg.%'
          )
      ) AS critical,
      first_pending.occurred_at AS oldest_pending_at
    FROM tenant t
    LEFT JOIN last_anchor a ON a.tenant_id = t.id
    JOIN LATERAL (
      SELECT occurred_at
      FROM audit_log pending_log
      WHERE pending_log.tenant_id = t.id
        AND pending_log.id > COALESCE(a.top_audit_id, 0)
      ORDER BY pending_log.id ASC
      LIMIT 1
    ) first_pending ON true
    LEFT JOIN tenant_setting s
      ON s.tenant_id = t.id AND s.key = ${AUDIT_ANCHOR_STATUS_SETTING_KEY}
    WHERE
      s.value IS NULL
      OR COALESCE(s.value->>'nextRetryAt', '') = ''
      OR (s.value->>'nextRetryAt')::timestamptz <= now()
    ORDER BY critical DESC, oldest_pending_at ASC
    LIMIT ${TENANT_BATCH}
  `;
  return rows.map((row) => row.tenant_id);
}

async function previousStatus(tenantId: string): Promise<PersistedAnchorStatus | null> {
  const stored = await withWorkerTenantContext(tenantId, (tx) =>
    readTenantSettingValue(tx, tenantId, AUDIT_ANCHOR_STATUS_SETTING_KEY),
  );
  return (stored ?? null) as PersistedAnchorStatus | null;
}

async function persistStatus(tenantId: string, status: PersistedAnchorStatus): Promise<void> {
  // TSA calls from overlapping 2-second ticks can finish out of order. Only a
  // status whose attempt started at least as late as the persisted one may
  // replace it; otherwise an old failure could overwrite a newer success.
  const attemptedAt = new Date(status.lastAttemptAt);
  await withWorkerTenantContext(
    tenantId,
    (tx) =>
      tx.$executeRaw`
      INSERT INTO tenant_setting (tenant_id, key, value, updated_at)
      VALUES (
        ${tenantId}::uuid,
        ${AUDIT_ANCHOR_STATUS_SETTING_KEY},
        ${JSON.stringify(status)}::jsonb,
        now()
      )
      ON CONFLICT (tenant_id, key) DO UPDATE
      SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
      WHERE COALESCE(
        (tenant_setting.value->>'lastAttemptAt')::timestamptz,
        '-infinity'::timestamptz
      ) <= ${attemptedAt}
    `,
  );
}

function inheritedStatus(previous: PersistedAnchorStatus | null) {
  return {
    lastSuccessAt: previous?.lastSuccessAt ?? null,
    lastAnchoredAuditId: previous?.lastAnchoredAuditId ?? null,
    tsaGenTime: previous?.tsaGenTime ?? null,
    trustAnchored: previous?.trustAnchored ?? false,
  };
}

function localOnlyStatus(
  attemptedAt: Date,
  previous: PersistedAnchorStatus | null,
  error: string,
): PersistedAnchorStatus {
  return {
    state: 'LOCAL_ONLY',
    lastAttemptAt: attemptedAt.toISOString(),
    ...inheritedStatus(previous),
    consecutiveFailures: 0,
    nextRetryAt: new Date(attemptedAt.getTime() + 60_000).toISOString(),
    error,
  };
}

function successStatus(
  attemptedAt: Date,
  result: { topAuditId: bigint; tsaGenTime: Date; trustAnchored: boolean },
): PersistedAnchorStatus {
  return {
    state: 'ANCHORED',
    lastAttemptAt: attemptedAt.toISOString(),
    lastSuccessAt: new Date().toISOString(),
    lastAnchoredAuditId: String(result.topAuditId),
    tsaGenTime: result.tsaGenTime.toISOString(),
    trustAnchored: result.trustAnchored,
    consecutiveFailures: 0,
    nextRetryAt: null,
    error: null,
  };
}

function delayedStatus(
  attemptedAt: Date,
  previous: PersistedAnchorStatus | null,
  failures: number,
  delay: number,
  error: string,
): PersistedAnchorStatus {
  return {
    state: 'DELAYED',
    lastAttemptAt: attemptedAt.toISOString(),
    ...inheritedStatus(previous),
    consecutiveFailures: failures,
    nextRetryAt: new Date(attemptedAt.getTime() + delay).toISOString(),
    error,
  };
}

async function anchorTenant(tenantId: string): Promise<{
  tenantId: string;
  anchored: boolean;
  topAuditId?: string;
  reason?: string;
}> {
  const attemptedAt = new Date();
  const previous = await previousStatus(tenantId);
  try {
    const port = await timestampPortFor(tenantId);
    const service = new EvidenceService(port);
    const result = await service.anchorLatest(prismaOwner, tenantId, {
      requireTrustAnchor: REQUIRE_TRUST_ANCHOR,
    });

    if (!result.anchored && result.reason.includes('keine externe')) {
      await persistStatus(tenantId, localOnlyStatus(attemptedAt, previous, result.reason));
      return { tenantId, anchored: false, reason: result.reason };
    }

    if (result.anchored) {
      await persistStatus(tenantId, successStatus(attemptedAt, result));
      return {
        tenantId,
        anchored: true,
        topAuditId: String(result.topAuditId),
      };
    }
    return { tenantId, anchored: false, reason: result.reason };
  } catch (err) {
    const failures = (previous?.consecutiveFailures ?? 0) + 1;
    const delay = Math.min(BASE_RETRY_MS * 2 ** Math.min(failures - 1, 6), MAX_RETRY_MS);
    const message = (err as Error).message;
    await persistStatus(tenantId, delayedStatus(attemptedAt, previous, failures, delay, message));
    log.error({ tenantId, err: message, retryMs: delay }, 'audit-anchor: tenant delayed');
    return { tenantId, anchored: false, reason: message };
  }
}

async function processInChunks(tenantIds: string[]) {
  const results: Awaited<ReturnType<typeof anchorTenant>>[] = [];
  for (let i = 0; i < tenantIds.length; i += PARALLEL_TENANTS) {
    results.push(
      ...(await Promise.all(tenantIds.slice(i, i + PARALLEL_TENANTS).map(anchorTenant))),
    );
  }
  return results;
}

export const auditAnchorWorker = new Worker<AuditAnchorJob>(
  JOB_QUEUES.auditAnchor.name,
  async (job) => {
    // The conditional DB insert in EvidenceService prevents anchor branches if
    // reconciliation ticks overlap across worker replicas.
    const tenantIds = job.data.tenantId ? [job.data.tenantId] : await pendingTenantIds();
    const results = await processInChunks(tenantIds);
    if (results.length > 0) {
      log.info({ results }, 'audit-anchor: reconciliation complete');
    }
    return { results };
  },
  { connection, concurrency: 4 },
);

auditAnchorWorker.on('failed', (job, err) => {
  log.error({ jobId: job?.id, err: err.message }, 'audit-anchor: failed');
});
