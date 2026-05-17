-- =============================================================================
-- Iter. 27: BWA-Plan trackt zuletzt-bearbeitet von
--
-- Damit auf dem Plan klar erkennbar ist, wer ihn zuletzt angefasst hat
-- (Mandant oder Kanzlei). Initial = createdBy/createdByType, danach immer
-- die Person des letzten Updates.
-- =============================================================================

ALTER TABLE "bwa_plan"
  ADD COLUMN "updated_by" UUID,
  ADD COLUMN "updated_by_type" TEXT;

UPDATE "bwa_plan"
SET "updated_by" = "created_by",
    "updated_by_type" = "created_by_type"
WHERE "updated_by" IS NULL;
