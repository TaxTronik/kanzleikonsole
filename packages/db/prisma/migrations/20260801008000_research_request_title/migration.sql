-- Recherchen bekommen einen Titel (auto-generiert oder vom Berater vergeben),
-- damit mehrere Einzelrecherchen zum selben Sachverhalt unterscheidbar sind.
ALTER TABLE "risk_research_request" ADD COLUMN "title" TEXT;
