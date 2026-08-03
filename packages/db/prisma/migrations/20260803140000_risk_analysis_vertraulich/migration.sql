-- Vertrauliche Subsumtions-Analyse: gesetzt vom Berufsträger; Mitarbeitende
-- ohne Schreibrecht sehen dann nur die ihnen zugewiesenen Textstellen.
ALTER TABLE "risk_analysis"
  ADD COLUMN IF NOT EXISTS "vertraulich" BOOLEAN NOT NULL DEFAULT false;
