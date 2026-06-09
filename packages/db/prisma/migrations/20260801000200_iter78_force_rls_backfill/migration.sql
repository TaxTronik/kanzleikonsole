-- =============================================================================
-- iter78 — RF-7: FORCE ROW LEVEL SECURITY für nach iter42 angelegte Tabellen.
--
-- iter42 hat FORCE RLS flächendeckend gesetzt (Begründung dort: RLS gilt per
-- Default NICHT für den Tabellen-Owner — laufen Migrationen/Tools als Owner,
-- liefe jede Policy ins Leere; FORCE schließt genau diese Lücke). Die danach
-- angelegten Tabellen haben das Muster nicht fortgeführt und hatten nur
-- ENABLE ROW LEVEL SECURITY:
--   - document_folder        (iter54)
--   - document_type          (iter55)
--   - risk_analysis          (iter60)
--   - risk_marking           (iter60)
--   - risk_research_request  (iter63)
--   - risk_research_result   (iter63)
--   - risk_prompt_template   (iter69)
-- =============================================================================

ALTER TABLE "document_folder" FORCE ROW LEVEL SECURITY;
ALTER TABLE "document_type" FORCE ROW LEVEL SECURITY;
ALTER TABLE "risk_analysis" FORCE ROW LEVEL SECURITY;
ALTER TABLE "risk_marking" FORCE ROW LEVEL SECURITY;
ALTER TABLE "risk_research_request" FORCE ROW LEVEL SECURITY;
ALTER TABLE "risk_research_result" FORCE ROW LEVEL SECURITY;
ALTER TABLE "risk_prompt_template" FORCE ROW LEVEL SECURITY;
