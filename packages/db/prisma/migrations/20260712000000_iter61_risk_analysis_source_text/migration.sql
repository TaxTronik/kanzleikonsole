-- =============================================================================
-- iter61: Subsumtions-Workspace — Sachverhalt-Text + LLM-Phasen-Status.
--
-- source_text: der analysierte Sachverhalt im Klartext. Nötig, um eine
--   gespeicherte Analyse WIEDER mit dem Highlight-Overlay (Zeichen-Offsets) zu
--   öffnen und um die asynchrone LLM-Phase 2 zu fahren. Mandanten-Arbeitsprodukt,
--   weiterhin RLS-geschützt (Policy aus iter60 greift unverändert).
-- title: optionale Bezeichnung der Subsumtion.
-- llm_enriched_at: gesetzt, sobald die LLM-Phase die Analyse angereichert hat.
--
-- source_text ist NOT NULL ohne Default — unkritisch, da risk_analysis neu/leer ist.
-- =============================================================================

-- AlterTable
ALTER TABLE "risk_analysis" ADD COLUMN     "llm_enriched_at" TIMESTAMPTZ(6),
ADD COLUMN     "source_text" TEXT NOT NULL,
ADD COLUMN     "title" TEXT;
