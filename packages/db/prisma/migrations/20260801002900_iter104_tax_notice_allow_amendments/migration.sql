-- =============================================================================
-- iter104 — Änderungsbescheide erfassbar machen.
--
-- Die Unique-Constraint (tenant, client, kind, period) auf tax_notice verhinderte
-- die Erfassung eines zweiten Bescheids derselben Steuerart/Periode. Das ist
-- fachlich falsch: Änderungsbescheide (§§ 164, 172 ff. AO) sind Alltag und lösen
-- jeweils eine neue, eigenständig laufende Einspruchsfrist aus (§ 355 AO). Der
-- zweite Bescheid warf bisher einen Prisma-P2002-Fehler und war gar nicht
-- erfassbar → die neue Frist blieb unüberwacht.
--
-- Der eindeutige Index wird durch einen nicht-uniquen Index über dieselben
-- Spalten ersetzt (Lesepfad bleibt performant). Keine Prisma-findUnique-/upsert-
-- Nutzung auf diesem Compound-Key (die Auto-Match-Abfrage liegt auf TaxFiling).
-- =============================================================================

DROP INDEX "tax_notice_tenant_id_client_id_kind_period_key";

CREATE INDEX "tax_notice_tenant_id_client_id_kind_period_idx"
    ON "tax_notice"("tenant_id", "client_id", "kind", "period");
