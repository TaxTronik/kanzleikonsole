-- ACCESS-STAFF-PERMISSION-001 / GWG-RISK-REVIEW-001
-- A professional qualification grants no administrative role or permission.
ALTER TABLE "staff_user"
  ADD COLUMN "is_professional" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "datev_advisor_number" VARCHAR(40),
  ADD COLUMN "professional_qualification_source" VARCHAR(10);

ALTER TABLE "staff_user" ADD CONSTRAINT "staff_professional_source_check"
  CHECK ("professional_qualification_source" IS NULL OR "professional_qualification_source" IN ('legacy', 'manual'));

-- Preserve existing explicit professional assignments, including inactive users.
-- Do not infer qualification from ADMIN/PARTNER, change active status, or claim review.
UPDATE "staff_user" AS staff
SET "is_professional" = true, "professional_qualification_source" = 'legacy'
WHERE EXISTS (
  SELECT 1 FROM "client_responsibility" AS responsibility
  WHERE responsibility."staff_id" = staff."id"
    AND responsibility."tenant_id" = staff."tenant_id"
    AND responsibility."role" = 'BERUFSTRAEGER'
);
