-- Serverseitige Dokumentpagination im Mandanten-Cockpit abdecken.
CREATE INDEX "document_client_id_deleted_at_created_at_id_idx"
  ON "document" ("client_id", "deleted_at", "created_at" DESC, "id" DESC);
