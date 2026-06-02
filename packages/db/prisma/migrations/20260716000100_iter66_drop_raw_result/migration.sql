-- =============================================================================
-- iter66: raw_result-Spalte droppen — Daten liegen jetzt in SeaweedFS (iter65 +
-- Daten-Migration). Postgres hält nur noch raw_result_bucket/raw_result_key.
-- =============================================================================

ALTER TABLE "risk_analysis" DROP COLUMN "raw_result";
