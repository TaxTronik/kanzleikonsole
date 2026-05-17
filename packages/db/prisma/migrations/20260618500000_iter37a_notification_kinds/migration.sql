-- Iter. 37a — neue Notification-Kinds für Kanzleikalender
-- (eigenes Migration-File, weil ALTER TYPE ... ADD VALUE nicht zusammen mit
--  Tabellen-DDL in derselben Transaktion laufen darf)

ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'APPOINTMENT_REQUESTED';
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'APPOINTMENT_DECIDED';
