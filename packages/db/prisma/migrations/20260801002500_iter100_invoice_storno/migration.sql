-- ----------------------------------------------------------------------------
-- iter100: Storno-Korrekturbeleg (§ 14c Abs. 1 i.V.m. § 17 UStG).
--
-- Bisher setzte cancelInvoiceAction eine versendete Rechnung nur auf CANCELLED —
-- OHNE Korrekturbeleg an den Empfänger. Die ausgewiesene USt blieb bis zur
-- wirksamen Berichtigung geschuldet. Jetzt erzeugt der Storno eine eigene
-- Stornorechnung (TypeCode 381, negierte Beträge, eigene lückenlose Nummer),
-- die auf die Originalrechnung verweist. storno_of_id verkettet beide.
-- Additiv, kein Backfill.
-- ----------------------------------------------------------------------------

ALTER TABLE "invoice" ADD COLUMN "storno_of_id" UUID;

ALTER TABLE "invoice"
  ADD CONSTRAINT "invoice_storno_of_fkey"
  FOREIGN KEY ("storno_of_id") REFERENCES "invoice"("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE INDEX "invoice_storno_of_idx" ON "invoice"("storno_of_id");
