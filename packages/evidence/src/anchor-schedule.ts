// =============================================================================
// P-05: Auswahl der Tenants für den Rolling-Anchor-Takt.
//
// Der Worker tickt alle 2 Sekunden. Ohne Mindestabstand bekam jeder Tenant mit
// neuem Audit-Eintrag in jedem Tick einen eigenen RFC-3161-Stempel. Jetzt gilt
// je Tenant ein Mindestabstand zum letzten Anker; offene Rechnungs- und
// GwG-Ereignisse werden weiterhin sofort verankert.
// =============================================================================

import type { EvidenceTx } from './service';
import { AUDIT_ANCHOR_STATUS_SETTING_KEY } from './verify-status';

/**
 * Audit-Aktionen, deren Einträge ohne Mindestabstand sofort extern verankert
 * werden: Rechnungen und GwG. Neben den Präfixen `invoice.` und `gwg.` zählen
 * dazu die Aktionen, die auch die Audit-Ansicht als GwG einordnet
 * (GwG-bedingte Mandantenänderung und -deaktivierung), sowie
 * StBVV-Rechnungsentwürfe. Der Audit-Eintrag trägt kein eigenes
 * Dringlichkeitsfeld; dies ist die einzige Definition für Worker und Tests.
 */
export const IMMEDIATE_ANCHOR_ACTIONS: {
  readonly prefixes: readonly string[];
  readonly exact: readonly string[];
} = {
  prefixes: ['invoice.', 'gwg.', 'stbvv.invoice.'],
  exact: ['client.update.gwg_relevant', 'client.deactivate.gwg_expired'],
};

/** Wird ein Eintrag mit dieser Aktion ohne Mindestabstand verankert? */
export function isImmediateAnchorAction(action: string): boolean {
  return (
    IMMEDIATE_ANCHOR_ACTIONS.exact.includes(action) ||
    IMMEDIATE_ANCHOR_ACTIONS.prefixes.some((prefix) => action.startsWith(prefix))
  );
}

/** LIKE-Muster der Präfixe; `%`, `_` und `\\` werden maskiert. */
export function immediateAnchorLikePatterns(): string[] {
  return IMMEDIATE_ANCHOR_ACTIONS.prefixes.map((prefix) => `${prefix.replace(/[\\%_]/g, '\\$&')}%`);
}

export interface AnchorScheduleOptions {
  /** Mindestabstand zum letzten Anker des Tenants ohne sofort zu verankernde Einträge. */
  minIntervalMs: number;
  /** Höchstens so viele Tenants je Takt. */
  limit: number;
}

/**
 * Tenants mit lokal noch nicht extern verankerten Einträgen, die jetzt
 * gestempelt werden dürfen: kein TSA-Backoff aktiv UND (sofort zu verankernder
 * Eintrag offen ODER noch kein Anker ODER letzter Anker älter als der
 * Mindestabstand). Reihenfolge: sofort zu verankernde zuerst, dann ältester
 * offener Eintrag.
 */
export async function tenantsDueForAnchoring(
  tx: EvidenceTx,
  opts: AnchorScheduleOptions,
): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ tenant_id: string }>>`
    SELECT due.tenant_id
    FROM (
      SELECT
        t.id AS tenant_id,
        EXISTS (
          SELECT 1
          FROM audit_log critical_log
          WHERE critical_log.tenant_id = t.id
            AND critical_log.id > COALESCE(a.top_audit_id, 0)
            AND (
              critical_log.action = ANY(${[...IMMEDIATE_ANCHOR_ACTIONS.exact]}::text[])
              OR critical_log.action LIKE ANY(${immediateAnchorLikePatterns()}::text[])
            )
        ) AS critical,
        a.created_at AS last_anchored_at,
        first_pending.occurred_at AS oldest_pending_at
      FROM tenant t
      LEFT JOIN LATERAL (
        SELECT top_audit_id, created_at
        FROM audit_anchor
        WHERE audit_anchor.tenant_id = t.id
        ORDER BY audit_anchor.id DESC
        LIMIT 1
      ) a ON true
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
    ) due
    WHERE due.critical
      OR due.last_anchored_at IS NULL
      OR due.last_anchored_at <= now() - ${opts.minIntervalMs}::int * interval '1 millisecond'
    ORDER BY due.critical DESC, due.oldest_pending_at ASC, due.tenant_id ASC
    LIMIT ${opts.limit}
  `;
  return rows.map((row) => row.tenant_id);
}
