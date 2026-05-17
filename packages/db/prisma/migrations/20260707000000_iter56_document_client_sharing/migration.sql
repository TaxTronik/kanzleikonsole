-- =============================================================================
-- iter56: Mandanten-Freigabe für Dokumente (Opt-in-Sharing).
--
-- Bisher sah der Mandant im Portal automatisch JEDES Dokument seines
-- Mandats. Künftig: Staff-Uploads sind privat (NULL), bis sie bewusst
-- freigegeben werden; shared_with_client_at gesetzt = portal-sichtbar.
--
-- Migrationsentscheidung (nicht-disruptiv): aller BESTAND mit client_id
-- wird als geteilt markiert (Portal-Sicht bleibt unverändert). Erst NEUE
-- Staff-Uploads sind ab Code-Deploy privat. Dokumente ohne client_id
-- (kanzlei-intern) sind portal-irrelevant → bleiben NULL.
-- =============================================================================

ALTER TABLE "document"
  ADD COLUMN "shared_with_client_at" TIMESTAMPTZ(6),
  ADD COLUMN "shared_by_staff"       UUID;

-- Bestand sichtbar lassen: vorhandene Mandanten-Dokumente als geteilt
-- markieren (Zeitpunkt = created_at, fachlich korrekt „seit Anlage sichtbar").
UPDATE "document"
SET "shared_with_client_at" = "created_at"
WHERE "client_id" IS NOT NULL
  AND "shared_with_client_at" IS NULL;

CREATE INDEX "document_client_id_shared_with_client_at_idx"
  ON "document" ("client_id", "shared_with_client_at");
