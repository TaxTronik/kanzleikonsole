-- ----------------------------------------------------------------------------
-- iter101: Befreiungsgrund für 0 %-Umsätze an der Rechnung.
--
-- § 14 Abs. 4 Nr. 8 UStG verlangt bei Steuerbefreiung einen Hinweis auf die
-- Befreiung (z. B. § 19 UStG Kleinunternehmer, § 4 UStG). Bisher wurden
-- 0 %-Positionen kommentarlos als EN-16931-Kategorie „Z" ausgewiesen. Mit einem
-- erfassten Grund wird die Kategorie „E" (steuerbefreit) mit BT-120 gesetzt.
-- Additiv, kein Backfill.
-- ----------------------------------------------------------------------------

ALTER TABLE "invoice" ADD COLUMN "vat_exemption_reason" TEXT;
