-- =============================================================================
-- iter62: Subsumtions-Workspace-Redesign — Engine-Meta + Berater-Darstellung.
--
-- engine_status: Detektionsstatus der Engine (treffer/luecke/kandidat/
--   unknown_risiko), für berater-gesetzte Markierungen `berater`. Treibt die
--   Statistik-Leiste (Treffer/Lücken/Unknown/Berater-Def) + die Anzeige-Filter
--   zählbar NACH Berater-Edits — anders als die statische Engine-summary.
-- streitig: aus `ist_streitig` der Engine; treibt den „Streit"-Filter.
-- farbe/label: nur Berater-Markierungen — frei gewählte Highlight-Farbe + Kategorie.
--
-- RLS-Policy aus iter60 greift unverändert; kein Default-Backfill nötig.
-- =============================================================================

-- AlterTable
ALTER TABLE "risk_marking" ADD COLUMN     "engine_status" TEXT,
ADD COLUMN     "farbe" TEXT,
ADD COLUMN     "label" TEXT,
ADD COLUMN     "streitig" BOOLEAN NOT NULL DEFAULT false;
