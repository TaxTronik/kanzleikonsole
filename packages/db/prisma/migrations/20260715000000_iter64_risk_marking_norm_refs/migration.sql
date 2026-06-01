-- =============================================================================
-- iter64: Norm-Referenzen pro Markierung — Gesetzestext-Expandable.
--
-- norm_refs: JSONB-Array [{zitat, id, titel}] mit der stabilen Engine-Norm-ID.
--   Die ID ist der Schlüssel für GET /v1/normgraph/aufloesen?id=… (lädt den
--   Gesetzestext on demand). normAnker (Zitate, text[]) bleibt für den Anzeige-
--   Fallback und die Recherche-Normanker-Heuristik bestehen.
--
-- Additiv & nullable → kein Backfill nötig; bestehende Markierungen fallen im UI
-- auf die reine Zitat-Anzeige zurück. Die RLS-Policy aus iter60 greift unverändert.
-- =============================================================================

-- AlterTable
ALTER TABLE "risk_marking" ADD COLUMN     "norm_refs" JSONB;
