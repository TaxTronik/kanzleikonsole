-- Priorität der Wiedervorlage: die delegierende Person kann nachträglich
-- hochstufen, ohne die Wiedervorlage neu anzulegen.
ALTER TABLE "client_reminder"
  ADD COLUMN IF NOT EXISTS "priority" "request_priority" NOT NULL DEFAULT 'NORMAL';

-- „Von mir delegiert"-Sicht der Übersichtsseite filtert auf created_by_staff.
CREATE INDEX IF NOT EXISTS "client_reminder_creator_idx"
  ON "client_reminder" ("created_by_staff", "done_at");

-- Rückmeldung an die delegierende Person, wenn eine Wiedervorlage erledigt wurde.
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'CLIENT_REMINDER_DONE';
