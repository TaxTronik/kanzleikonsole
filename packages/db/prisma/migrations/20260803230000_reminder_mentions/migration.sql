-- @-Erwähnungen in Wiedervorlagen-Wortmeldungen + individueller
-- Benachrichtigungs-Modus. Wer auf MENTIONS_ONLY stellt, bekommt vom
-- laufenden Austausch (Chat/Uploads/Nachfassen) nur noch gezielte
-- Ansprachen; Zuweisungen und Fälligkeiten kommen weiterhin immer.
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'CLIENT_REMINDER_MENTION';

DO $$ BEGIN
  CREATE TYPE "reminder_notify_mode" AS ENUM ('ALL', 'MENTIONS_ONLY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "staff_user"
  ADD COLUMN IF NOT EXISTS "reminder_notify_mode" "reminder_notify_mode" NOT NULL DEFAULT 'ALL';
