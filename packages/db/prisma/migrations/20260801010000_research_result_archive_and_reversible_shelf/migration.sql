-- Archivierung ist ein eigener, reversibler Zustand. Bisherige VERWORFEN-
-- Ergebnisse werden als archiviert übernommen und wieder zu regulären,
-- unzugeordneten Ergebnissen.
ALTER TABLE "risk_research_result"
  ADD COLUMN "archived_at" TIMESTAMPTZ(6);

UPDATE "risk_research_result"
SET
  "archived_at" = "received_at",
  "status" = 'NEU'
WHERE "status" = 'VERWORFEN';

CREATE INDEX "risk_research_result_tenant_id_archived_at_idx"
  ON "risk_research_result"("tenant_id", "archived_at");

-- Ob eine erneute Ablage möglich ist, hängt nur noch an der aktuellen
-- Dokumentverknüpfung. Beim Löschen des Dokuments wird diese gelöst.
ALTER TABLE "risk_research_result"
  DROP COLUMN "saved_to_shelf_at";
