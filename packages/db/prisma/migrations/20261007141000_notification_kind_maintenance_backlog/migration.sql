-- Fachkatalog: AUDIT-ARCHIVE-001, DSGVO-OPERATIONAL-RETENTION-001
-- (notification_kind aus 20260521000000_iter8_notifications, zuletzt als Typ neu
-- angelegt in 20260801000600_iter81)
--
-- Review-Befund P-17 / Entscheidung B14: Der Rückstand der Wartungsjobs
-- audit-rotate und storage-orphan-cleanup wird zur Health-Kennzahl; hält er die
-- Alarmschwelle, erhalten die aktiven ADMIN/PARTNER der betroffenen Kanzlei
-- einen Hinweis. Je Job eine eigene Art, damit beide Hinweise am selben Tag
-- nebeneinander bestehen (Ressource ist jeweils der Tenant).
--
-- Die Enum-Werte stehen bewusst allein in dieser Migration: PostgreSQL darf sie
-- erst nach dem Commit verwenden. Die Tages-Dedupe-Indizes folgen in
-- 20261007141100_notification_daily_dedupe_maintenance_backlog.
BEGIN;

ALTER TYPE public.notification_kind
  ADD VALUE IF NOT EXISTS 'SYSTEM_AUDIT_ARCHIVE_BACKLOG';

ALTER TYPE public.notification_kind
  ADD VALUE IF NOT EXISTS 'SYSTEM_STORAGE_CLEANUP_BACKLOG';

COMMIT;
