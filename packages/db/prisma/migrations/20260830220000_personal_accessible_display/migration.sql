-- Personal display preference, independently scoped to each authenticated
-- staff account or portal contact profile. Existing accounts keep the default
-- view; the shared accessibility improvements remain active in both modes.
-- Existing tenant RLS, FORCE RLS and table grants also cover these columns.
BEGIN;

ALTER TABLE "staff_user"
  ADD COLUMN "accessible_display" BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE "client_contact"
  ADD COLUMN "accessible_display" BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
