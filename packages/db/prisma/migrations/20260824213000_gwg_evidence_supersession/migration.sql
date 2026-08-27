ALTER TABLE "gwg_id_document"
ADD COLUMN "superseded_at" TIMESTAMPTZ(6),
ADD COLUMN "superseded_by_document_set_id" UUID;

CREATE INDEX "gwg_id_document_gwg_check_id_superseded_at_idx"
ON "gwg_id_document"("gwg_check_id", "superseded_at");
