-- Personal display aids only. Existing RLS, grants, tenant and actor scopes remain unchanged.
-- Independent columns allow field-level updates without overwriting other display preferences.
BEGIN;

ALTER TABLE "staff_user"
  ADD COLUMN "accessible_display_font_size" TEXT NOT NULL DEFAULT 'large',
  ADD COLUMN "accessible_display_spacing" TEXT NOT NULL DEFAULT 'relaxed',
  ADD COLUMN "accessible_display_contrast" TEXT NOT NULL DEFAULT 'strong',
  ADD COLUMN "accessible_display_reduce_motion" BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE "client_contact"
  ADD COLUMN "accessible_display_font_size" TEXT NOT NULL DEFAULT 'large',
  ADD COLUMN "accessible_display_spacing" TEXT NOT NULL DEFAULT 'relaxed',
  ADD COLUMN "accessible_display_contrast" TEXT NOT NULL DEFAULT 'strong',
  ADD COLUMN "accessible_display_reduce_motion" BOOLEAN NOT NULL DEFAULT TRUE;

COMMIT;
