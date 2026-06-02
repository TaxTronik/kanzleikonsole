-- =============================================================================
-- iter65: rawResult aus Postgres in den Object-Store (SeaweedFS) auslagern.
--
-- rawResult (Engine-JSON) ist reines Write-Only-Kaltarchiv (Audit/Replay) und
-- zur Laufzeit ungelesen — in Postgres aber der größte Einzelposten (~⅓ der
-- Analyse). Künftig: gzip in SeaweedFS, nur Bucket/Key bleiben hier.
--
-- Phase 1 (dieser Schritt): Referenz-Spalten anlegen + raw_result nullable
-- machen, damit neuer Code die Spalte weglassen kann. Die Daten-Migration
-- (Bestand → SeaweedFS) läuft als Skript dazwischen; DROP folgt in iter66.
--
-- RLS-Policy aus iter60 greift unverändert; additiv/nullable → kein Backfill.
-- =============================================================================

ALTER TABLE "risk_analysis"
  ALTER COLUMN "raw_result" DROP NOT NULL,
  ADD COLUMN "raw_result_bucket" TEXT,
  ADD COLUMN "raw_result_key" TEXT;
