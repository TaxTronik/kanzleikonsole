-- =============================================================================
-- Iter. 19: Client-Master-Change-Requests (Mandanten-Self-Service)
--
-- Mandanten schlagen aus dem Portal Änderungen an ihren Stammdaten vor.
-- Die Anfragen landen als PENDING in dieser Tabelle und werden von einem
-- Bearbeiter genehmigt oder abgelehnt. Erst bei Genehmigung wird die
-- client-Tabelle aktualisiert. GwG-relevante Felder lösen zusätzlich eine
-- Re-Verifikation des GwG-Checks aus (analog zu saveGwgFieldsAction).
-- =============================================================================

ALTER TYPE "notification_kind" ADD VALUE 'CLIENT_MASTER_CHANGE_REQUEST';

CREATE TYPE "client_master_change_status" AS ENUM ('PENDING','APPROVED','REJECTED','WITHDRAWN');

CREATE TABLE "client_master_change_request" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"     UUID NOT NULL,
  "client_id"     UUID NOT NULL,
  "contact_id"    UUID NOT NULL,
  "fields"        JSONB NOT NULL,
  "note"          TEXT,
  "status"        "client_master_change_status" NOT NULL DEFAULT 'PENDING',
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decided_at"    TIMESTAMP(3),
  "decided_by"    UUID,
  "decision_note" TEXT,
  CONSTRAINT "client_master_change_request_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "client_master_change_request_tenant_status_idx"
  ON "client_master_change_request" ("tenant_id","status","created_at" DESC);
CREATE INDEX "client_master_change_request_client_idx"
  ON "client_master_change_request" ("client_id","created_at" DESC);

ALTER TABLE "client_master_change_request"
  ADD CONSTRAINT "client_master_change_request_tenant_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE;
ALTER TABLE "client_master_change_request"
  ADD CONSTRAINT "client_master_change_request_client_fk"
  FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE CASCADE;
ALTER TABLE "client_master_change_request"
  ADD CONSTRAINT "client_master_change_request_contact_fk"
  FOREIGN KEY ("contact_id") REFERENCES "client_contact"("id") ON DELETE RESTRICT;
ALTER TABLE "client_master_change_request"
  ADD CONSTRAINT "client_master_change_request_decided_by_fk"
  FOREIGN KEY ("decided_by") REFERENCES "staff_user"("id") ON DELETE SET NULL;

ALTER TABLE "client_master_change_request" ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_master_change_request_isolation ON "client_master_change_request"
  USING ("tenant_id" = app.current_tenant_id())
  WITH CHECK ("tenant_id" = app.current_tenant_id());
