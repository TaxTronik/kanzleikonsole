-- ----------------------------------------------------------------------------
-- iter98: Leistungszeitraum an der Rechnung.
--
-- § 14 Abs. 4 Nr. 6 UStG verlangt den Zeitpunkt/Zeitraum der Leistung. Bisher
-- war er hart = Rechnungsdatum (BT-72), was bei kanzleitypischer Nachlauf-
-- Abrechnung ("Leistung Juni, Rechnung Juli") den Vorsteuerabzug des Empfängers
-- gefährdet. Zwei nullable Date-Spalten (Monatsgenauigkeit reicht,
-- § 31 Abs. 4 UStDV). NULL = kein separater Zeitraum → Rechnungsdatum gilt.
-- Additiv, kein Backfill: Bestandsrechnungen behalten NULL (Verhalten wie bisher).
-- ----------------------------------------------------------------------------

ALTER TABLE "invoice" ADD COLUMN "service_period_start" DATE;
ALTER TABLE "invoice" ADD COLUMN "service_period_end"   DATE;
