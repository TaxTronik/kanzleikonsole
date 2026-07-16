-- Default-Sortierung der mandantenweiten Anforderungsliste abdecken.
CREATE INDEX "request_tenant_id_created_at_idx"
  ON "request" ("tenant_id", "created_at" DESC);
