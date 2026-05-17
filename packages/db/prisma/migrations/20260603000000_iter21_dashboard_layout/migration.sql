-- =============================================================================
-- Iter. 21: Persönliches Dashboard-Layout pro Mitarbeiter
--
-- Jeder Mitarbeiter stellt sich sein Dashboard aus Widgets selbst zusammen.
-- Layout als kompakter JSON-Blob am staff_user — keine eigene Tabelle nötig
-- (Schreib-Last vernachlässigbar, kein Cross-Staff-Lookup).
-- =============================================================================

ALTER TABLE "staff_user"
  ADD COLUMN "dashboard_layout" JSONB;
