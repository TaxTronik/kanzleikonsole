-- =============================================================================
-- Q-2: Partial-Unique-Index gegen doppelte Tagesreminder.
--
-- Hintergrund: reminders-daily-Worker hatte ein findFirst-then-create-Pattern
-- ohne Transaktion — bei parallelem Lauf (Scheduler-Tick + manueller Admin-
-- Trigger / Doppel-Click) sind beide Inserts durchgegangen. Folge: doppelte
-- „Wiedervorlage-fällig"-Notifications.
--
-- Fix auf DB-Ebene: pro (tenant_id, kind, resource_id, Tag) darf nur eine
-- Reminder-Notification existieren.
--
-- Postgres-Subtilität: timestamptz → date kann via `AT TIME ZONE 'UTC'::date`
-- ausgedrückt werden, aber dieser Ausdruck ist STABLE (nicht IMMUTABLE) und
-- damit nicht index-tauglich. Auch ein PL/pgSQL-Wrapper mit IMMUTABLE-Hint
-- wird vom Planner durchschaut.
--
-- Trick: `floor(extract(epoch from ts) / 86400)` ist IMMUTABLE, weil
-- `extract(epoch from timestamptz)` die absolute Sekundenzahl seit Unix-Epoch
-- liefert (timezone-unabhängig). Wir bekommen damit eine eindeutige Tag-Bucket-
-- Zahl pro UTC-Tag, die als Index-Schlüssel funktioniert.
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS notification_daily_dedupe
  ON notification (
    tenant_id,
    kind,
    resource_id,
    (floor(extract(epoch from created_at) / 86400))
  )
  WHERE kind IN ('TAX_NOTICE_APPEAL_REMINDER', 'CLIENT_REMINDER_DUE', 'PENDING_BINDER_OVERDUE')
    AND resource_id IS NOT NULL;
