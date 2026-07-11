-- =============================================================================
-- iter108 — genau ein Korrekturbeleg je Originalrechnung.
--
-- Der Storno-Ablauf lässt das Original jetzt so lange aktiv, bis der
-- Korrekturbeleg revisionssicher erzeugt und auf SENT festgeschrieben ist.
-- Deshalb darf ein paralleler zweiter Request keinen zweiten Entwurf anlegen.
-- NULL bleibt beliebig oft erlaubt (normale Rechnungen); nur gesetzte
-- storno_of_id-Werte sind eindeutig.
-- =============================================================================

CREATE UNIQUE INDEX "invoice_storno_of_unique"
  ON "invoice" ("storno_of_id")
  WHERE "storno_of_id" IS NOT NULL;
