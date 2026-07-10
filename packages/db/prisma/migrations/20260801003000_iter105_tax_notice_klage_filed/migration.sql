-- =============================================================================
-- iter105 — Klageeinreichung im Fristenkontrollbuch belastbar belegen.
--
-- Für erledigte Klagefristen (Status KLAGE) verwendete das Kontrollbuch bisher
-- appealResolvedAt (= Bekanntgabe der Einspruchsentscheidung, also der Frist-
-- BEGINN) als Erledigungszeit und reviewedBy (= Bescheidprüfer) als Bearbeiter
-- — beides belegt NICHT, wann und durch wen die fristwahrende Klage eingereicht
-- wurde. Zwei additive, nullable Spalten halten das nun fest; sie werden beim
-- Statuswechsel auf KLAGE gesetzt. Kein Backfill (Altbestand → NULL, im
-- Kontrollbuch als unbekannt/Fallback behandelt).
-- =============================================================================

ALTER TABLE "tax_notice" ADD COLUMN "klage_filed_at" TIMESTAMP(3);
ALTER TABLE "tax_notice" ADD COLUMN "klage_filed_by" UUID;
