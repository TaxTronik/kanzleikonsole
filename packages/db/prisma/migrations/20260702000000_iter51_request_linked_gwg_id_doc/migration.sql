-- =============================================================================
-- U-5: Saubere Idempotenz für Auto-Requests aus dem gwg-expiry-check-Worker.
--
-- Vorher matchte der Worker offene Auto-Requests per `title contains ownerName`.
-- Bei zwei BeneficialOwners „Müller" und „Müller-Schmidt" hätte der Substring-
-- Match den zweiten Auto-Request fälschlich unterdrückt → fehlende GwG-ID-
-- Anforderung.
--
-- Fix: dedizierte FK `linked_gwg_id_document_id` auf gwg_id_document.id.
-- Idempotenz-Check wird ein exakter findFirst auf diesem Feld.
-- =============================================================================

ALTER TABLE "request"
  ADD COLUMN "linked_gwg_id_document_id" UUID;

ALTER TABLE "request"
  ADD CONSTRAINT "request_gwg_id_doc_fk"
  FOREIGN KEY ("linked_gwg_id_document_id")
  REFERENCES "gwg_id_document"("id")
  ON DELETE SET NULL
  ON UPDATE NO ACTION;

CREATE INDEX "request_gwg_id_doc_idx"
  ON "request"("linked_gwg_id_document_id");
