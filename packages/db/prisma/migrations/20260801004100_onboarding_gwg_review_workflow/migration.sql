-- Persist the explicitly completed initial onboarding and make the
-- employee -> professional GwG hand-off auditable.
ALTER TABLE "client"
  ADD COLUMN IF NOT EXISTS "onboarding_completed_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "onboarding_completed_by" UUID;

ALTER TABLE "gwg_check"
  ADD COLUMN IF NOT EXISTS "review_submitted_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "review_submitted_by" UUID;

-- Preserve the historical COMPLETE contract from before the explicit marker:
-- at least one active contact plus a check that was actually verified at some
-- point. The exact business completion time cannot be reconstructed reliably
-- (the contact may have been created or reactivated after verification), so the
-- marker honestly records the migration/backfill time instead of inventing an
-- earlier timestamp. NULL onboarding_completed_by identifies this inferred
-- legacy completion. Current allow_active/status are deliberately irrelevant
-- because a later reverification must not reopen initial onboarding.
UPDATE "client" c
   SET "onboarding_completed_at" = statement_timestamp()
 WHERE c."onboarding_completed_at" IS NULL
   AND EXISTS (
         SELECT 1
           FROM "gwg_check" g
          WHERE g."tenant_id" = c."tenant_id"
            AND g."client_id" = c."id"
            AND g."verified_at" IS NOT NULL
       )
   AND EXISTS (
         SELECT 1
           FROM "client_contact" cc
          WHERE cc."tenant_id" = c."tenant_id"
            AND cc."client_id" = c."id"
            AND cc."active" = TRUE
       );

CREATE INDEX IF NOT EXISTS "client_tenant_onboarding_completed_idx"
  ON "client" ("tenant_id", "onboarding_completed_at");

CREATE INDEX IF NOT EXISTS "gwg_check_tenant_review_submitted_idx"
  ON "gwg_check" ("tenant_id", "review_submitted_at")
  WHERE "status" = 'IN_REVIEW'::"gwg_status";
