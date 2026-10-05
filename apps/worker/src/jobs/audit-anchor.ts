// =============================================================================
// Non-blocking rolling RFC-3161 anchors.
//
// The worker only reads committed audit rows. The TSA HTTP request never runs
// inside a business transaction and never holds the local audit advisory lock,
// so writers continue appending while an older prefix is being timestamped.
//
// P-05: per tenant at most one anchor per AUDIT_ANCHOR_MIN_TENANT_INTERVAL_MS
// unless invoice/GwG entries are pending. A committed per-tenant lease
// (audit_anchor_lease) is held across the TSA call so overlapping runs never
// request a token for the same chain tip; no transaction or pooled connection
// is held during the HTTP request. Only TSA errors count for the backoff.
// =============================================================================

import { createWorker } from '../worker-factory';
import { env } from '@taxtronik/config';
import { AUDIT_ANCHOR_MIN_TENANT_INTERVAL_MS, JOB_QUEUES } from '@taxtronik/config/job-queues';
import { readTenantSettingValue } from '@taxtronik/db/tenant-settings';
import {
  ANCHOR_LOCKED_REASON,
  AUDIT_ANCHOR_STATUS_SETTING_KEY,
  EvidenceService,
  anchorLatestWithLease,
  tenantsDueForAnchoring,
  type AnchorAttempt,
  type PersistedAnchorStatus,
  type SettledAnchorAttempt,
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

/**
 * Tenants with pending entries that may be stamped now: invoice/GwG entries
 * immediately, everything else at most once per minimum interval per tenant.
 */
function pendingTenantIds(): Promise<string[]> {
  return tenantsDueForAnchoring(prismaOwner, {
    minIntervalMs: AUDIT_ANCHOR_MIN_TENANT_INTERVAL_MS,
    limit: TENANT_BATCH,
  });
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

interface AnchorTenantResult {
  tenantId: string;
  anchored: boolean;
  topAuditId?: string;
  reason?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Speichert den Ausgang noch unter dem Tenant-Lease. Nur TSA-Fehler starten
 * den Backoff; Datenbank- und Pool-Fehler lassen den Status unverändert.
 */
async function persistAttempt(
  tenantId: string,
  attemptedAt: Date,
  previous: PersistedAnchorStatus | null,
  attempt: SettledAnchorAttempt,
): Promise<void> {
  if (attempt.status === 'done') {
    const result = attempt.result;
    if (result.anchored) {
      await persistStatus(tenantId, successStatus(attemptedAt, result));
    } else if (result.reason.includes('keine externe')) {
      await persistStatus(tenantId, localOnlyStatus(attemptedAt, previous, result.reason));
    }
    return;
  }
  if (attempt.status === 'tsa-failed') {
    const failures = (previous?.consecutiveFailures ?? 0) + 1;
    const delay = Math.min(BASE_RETRY_MS * 2 ** Math.min(failures - 1, 6), MAX_RETRY_MS);
    const message = attempt.error.message;
    await persistStatus(tenantId, delayedStatus(attemptedAt, previous, failures, delay, message));
    log.error({ tenantId, err: message, retryMs: delay }, 'audit-anchor: tenant delayed');
  }
}

function summarize(tenantId: string, attempt: AnchorAttempt): AnchorTenantResult {
  switch (attempt.status) {
    case 'locked':
      return { tenantId, anchored: false, reason: ANCHOR_LOCKED_REASON };
    case 'done':
      return attempt.result.anchored
        ? { tenantId, anchored: true, topAuditId: String(attempt.result.topAuditId) }
        : { tenantId, anchored: false, reason: attempt.result.reason };
    case 'tsa-failed':
      return { tenantId, anchored: false, reason: attempt.error.message };
    case 'failed':
      // Infrastrukturfehler: kein TSA-Backoff, nächster Takt versucht erneut.
      log.warn({ tenantId, err: errorMessage(attempt.error) }, 'audit-anchor: tenant skipped');
      return { tenantId, anchored: false, reason: errorMessage(attempt.error) };
  }
}

async function anchorTenant(tenantId: string): Promise<AnchorTenantResult> {
  const attemptedAt = new Date();
  try {
    const previous = await previousStatus(tenantId);
    const service = new EvidenceService(await timestampPortFor(tenantId));
    // A run that does not get the tenant lease returns without a TSA request
    // and without touching the persisted status.
    const attempt = await anchorLatestWithLease(
      service,
      prismaOwner,
      tenantId,
      { requireTrustAnchor: REQUIRE_TRUST_ANCHOR },
      (settled) => persistAttempt(tenantId, attemptedAt, previous, settled),
    );
    return summarize(tenantId, attempt);
  } catch (err) {
    // Datenbank-/Pool-Fehler (Status, Konfiguration): kein TSA-Backoff.
    log.warn({ tenantId, err: errorMessage(err) }, 'audit-anchor: tenant skipped');
    return { tenantId, anchored: false, reason: errorMessage(err) };
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

export const auditAnchorWorker = createWorker<AuditAnchorJob>(
  JOB_QUEUES.auditAnchor.name,
  async (job) => {
    // The per-tenant lease avoids duplicate TSA requests; the conditional DB
    // insert in EvidenceService still prevents anchor branches if a run
    // without the lease (e.g. during a rolling deploy) overlaps.
    const tenantIds = job.data.tenantId ? [job.data.tenantId] : await pendingTenantIds();
    const results = await processInChunks(tenantIds);
    if (results.length > 0) {
      log.info({ results }, 'audit-anchor: reconciliation complete');
    }
    return { results };
  },
  { connection, concurrency: 4 },
);
