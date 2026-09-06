import { withTenantContext } from '@taxtronik/db';
import { readTenantSettingValue } from '@taxtronik/db/tenant-settings';
import {
  AUDIT_RECOVERY_CHECKPOINT_SETTING_KEY,
  AUDIT_ANCHOR_STATUS_SETTING_KEY,
  AUDIT_VERIFY_RESULT_SETTING_KEY,
  type PersistedAnchorStatus,
  type PersistedRecoveryCheckpoint,
  type PersistedVerifyResult,
} from '@taxtronik/evidence';
import { AUDIT_PAGE_SIZE, type AuditPageQuery } from './audit-page-state';

export interface AnchorSummary {
  last_anchored_audit_id: bigint | null;
  tsa_gen_time: Date | null;
  trust_anchored: boolean | null;
  pending_count: bigint;
  oldest_pending_at: Date | null;
}

function normalizeAnchorSummary(rows: AnchorSummary[]): AnchorSummary {
  return (
    rows[0] ?? {
      last_anchored_audit_id: null,
      tsa_gen_time: null,
      trust_anchored: null,
      pending_count: BigInt(0),
      oldest_pending_at: null,
    }
  );
}

/** Called only after the page's ADMIN/PARTNER guard; all reads share its tenant context. */
export async function loadAuditPageData(
  tenantId: string,
  staffId: string,
  filters: AuditPageQuery,
) {
  const [
    entries,
    verifySetting,
    checkpointSetting,
    anchorStatusSetting,
    anchorSummaryRows,
    resourceTypeRows,
    totalCount,
  ] = await withTenantContext({ tenantId, actorId: staffId, actorType: 'STAFF' }, async (tx) =>
    Promise.all([
      tx.auditLog.findMany({
        where: { ...filters.where, tenantId },
        orderBy: { id: filters.query.sort === 'oldest' ? 'asc' : 'desc' },
        take: AUDIT_PAGE_SIZE + 1,
      }),
      // P-1: Chain-Verifikation läuft NICHT mehr im Render-Pfad (SHA-256 über
      // den kompletten Log; Sekunden bei 200k, P2028 ab ~500k). Hier nur das
      // vom täglichen Worker-Job (audit-verify-check) persistierte Ergebnis.
      readTenantSettingValue(tx, tenantId, AUDIT_VERIFY_RESULT_SETTING_KEY),
      readTenantSettingValue(tx, tenantId, AUDIT_RECOVERY_CHECKPOINT_SETTING_KEY),
      readTenantSettingValue(tx, tenantId, AUDIT_ANCHOR_STATUS_SETTING_KEY),
      tx.$queryRaw<AnchorSummary[]>`
          WITH latest_anchor AS (
            SELECT top_audit_id, tsa_gen_time, trust_anchored
            FROM audit_anchor
            WHERE tenant_id = ${tenantId}::uuid
            ORDER BY id DESC
            LIMIT 1
          )
          SELECT
            (SELECT top_audit_id FROM latest_anchor) AS last_anchored_audit_id,
            (SELECT tsa_gen_time FROM latest_anchor) AS tsa_gen_time,
            (SELECT trust_anchored FROM latest_anchor) AS trust_anchored,
            count(l.id)::bigint AS pending_count,
            min(l.occurred_at) AS oldest_pending_at
          FROM audit_log l
          WHERE l.tenant_id = ${tenantId}::uuid
            AND l.id > COALESCE((SELECT top_audit_id FROM latest_anchor), 0)
        `,
      // P-1: groupBy statt distinct — Prisma dedupliziert `distinct` ohne
      // nativeDistinct IN-MEMORY und überträgt dafür JEDE Zeile.
      tx.auditLog.groupBy({
        by: ['resourceType'],
        where: { tenantId },
        orderBy: { resourceType: 'asc' },
      }),
      // AUDIT-HASH-CHAIN-001 / ACCESS-TENANT-RLS-001: pg_class statistics
      // are database-wide. Count only this tenant, without the page cursor.
      // The existing (tenant_id, id) index supports this tenant restriction.
      tx.auditLog.count({ where: { ...filters.countWhere, tenantId } }),
    ]),
  );

  return {
    entries,
    resourceTypeRows,
    totalCount,
    verifyResult: (verifySetting ?? null) as PersistedVerifyResult | null,
    checkpoint: (checkpointSetting ?? null) as PersistedRecoveryCheckpoint | null,
    anchorStatus: (anchorStatusSetting ?? null) as PersistedAnchorStatus | null,
    anchorSummary: normalizeAnchorSummary(anchorSummaryRows),
  };
}

export type AuditPageData = Awaited<ReturnType<typeof loadAuditPageData>>;
