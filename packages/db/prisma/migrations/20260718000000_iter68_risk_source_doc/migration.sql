-- =============================================================================
-- iter68: Formatierter Sachverhalt (Rich-Doc) für den Subsumtions-Workspace.
--
-- source_doc: Tiptap/ProseMirror-JSON des Sachverhalts. source_text bleibt die
-- daraus abgeleitete Plaintext-Serialisierung (Engine + Zeichen-Offsets + Hash).
-- Additiv/nullable → Alt-Analysen ohne Rich-Doc fallen im Review auf die
-- Plaintext-Ansicht zurück. RLS-Policy aus iter60 greift unverändert.
-- =============================================================================

ALTER TABLE "risk_analysis" ADD COLUMN "source_doc" JSONB;
