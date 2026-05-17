-- =============================================================================
-- W-2: notification_daily_dedupe-Index erweitern.
--
-- Q-2 hatte den Index nur für die drei reminders-daily-Kinds gesetzt. U-1
-- hat die Worker gwg-expiry-check und invoice-overdue-check zwar auf das
-- withWorkerTenantContext + P2002-Catch-Pattern umgestellt, aber ohne
-- passenden DB-Unique-Index löst P2002 nie aus — Race bleibt theoretisch
-- möglich (Scheduler-Tick + manueller Admin-Trigger).
--
-- Außerdem: `staff_id` gehört in den Index-Schlüssel. Bei einer Notification
-- an drei Berufsträger gleichzeitig hat jede ihren eigenen staff_id; ohne
-- staff_id würde der Unique-Index nur einen davon zulassen.
-- =============================================================================

DROP INDEX IF EXISTS notification_daily_dedupe;

CREATE UNIQUE INDEX notification_daily_dedupe
  ON notification (
    tenant_id,
    staff_id,
    kind,
    resource_id,
    (floor(extract(epoch from created_at) / 86400))
  )
  WHERE kind IN (
    'TAX_NOTICE_APPEAL_REMINDER',
    'CLIENT_REMINDER_DUE',
    'PENDING_BINDER_OVERDUE',
    'INVOICE_OVERDUE',
    'GWG_EXPIRY_90D',
    'GWG_EXPIRY_30D',
    'GWG_EXPIRED',
    'GWG_ID_EXPIRY_SOON',
    'GWG_ID_EXPIRED'
  )
    AND resource_id IS NOT NULL
    AND staff_id IS NOT NULL;
