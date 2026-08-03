-- Rückkanal der Wiedervorlagen: Wortmeldungen und Nachfassen erreichen die
-- Beteiligten. Bisher lief die Benachrichtigung nur in EINE Richtung
-- (Zuweisung an die zuständige Person) — wer delegiert hatte, erfuhr weder von
-- Rückfragen noch von Folgestufen.
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'CLIENT_REMINDER_NOTE';
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'CLIENT_REMINDER_FOLLOWUP';
