-- Iter. 58 — Notification-Kind für fehlgeschlagenen Mailversand.
-- Genutzt z. B. wenn der Magic-Link-/Template-Mailversand scheitert: die
-- Kanzlei sieht in der UI, dass ein Kontakt seine Mail NICHT erhalten hat,
-- und kann nachfassen (bisher nur im Server-Log sichtbar).
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'SYSTEM_MAIL_FAILED';
