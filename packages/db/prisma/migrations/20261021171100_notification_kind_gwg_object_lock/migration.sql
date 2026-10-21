-- TCMS-NACHWEIS-001 / GWG-RETENTION-DESTRUCTION-001
-- (notification_kind aus 20260521000000_iter8_notifications, zuletzt als Typ neu
-- angelegt in 20260801000600_iter81)
--
-- RT3D-K-01 (kk-tcms-fix5): Der Wartungsjob gwg-object-lock-extend verlängert
-- den Object-Lock gebundener GwG-Belege. Scheitert das Verlängern über die
-- Alarmschwelle der Wartungsjobs (B14) hinaus, erhalten die aktiven
-- ADMIN/PARTNER der betroffenen Kanzlei einen Hinweis dieser eigenen Art
-- (Ressource ist der Tenant, wie bei den übrigen Wartungsrückständen).
--
-- Der Enum-Wert steht bewusst allein in dieser Migration: PostgreSQL darf ihn
-- erst nach dem Commit verwenden. Tabelle und Tages-Dedupe-Indizes folgen in
-- 20261021171200_gwg_object_lock_extension.
BEGIN;

ALTER TYPE public.notification_kind
  ADD VALUE IF NOT EXISTS 'SYSTEM_GWG_OBJECT_LOCK_BACKLOG';

COMMIT;
