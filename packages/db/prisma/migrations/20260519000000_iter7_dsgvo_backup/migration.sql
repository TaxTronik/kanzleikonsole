-- =============================================================================
-- Iter. 7: DSGVO-Requests + Backup-Records + Härtung
-- =============================================================================

CREATE TYPE "dsgvo_request_type"   AS ENUM (
    'ACCESS', 'RECTIFICATION', 'ERASURE', 'RESTRICTION', 'PORTABILITY', 'OBJECTION'
);
CREATE TYPE "dsgvo_request_status" AS ENUM (
    'RECEIVED', 'IN_PROGRESS', 'COMPLETED', 'REJECTED'
);
CREATE TYPE "dsgvo_subject_type"   AS ENUM (
    'CLIENT_CONTACT', 'STAFF_USER', 'CLIENT', 'EXTERNAL'
);
CREATE TYPE "backup_status"        AS ENUM ('RUNNING', 'SUCCESS', 'FAILED');

CREATE TABLE "dsgvo_request" (
    "id"                  UUID                   NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id"           UUID                   NOT NULL,
    "type"                "dsgvo_request_type"   NOT NULL,
    "status"              "dsgvo_request_status" NOT NULL DEFAULT 'RECEIVED',
    "subject_type"        "dsgvo_subject_type"   NOT NULL,
    "subject_ref_id"      UUID,
    "subject_email"       CITEXT                 NOT NULL,
    "subject_name"        TEXT                   NOT NULL,
    "description"         TEXT                   NOT NULL,
    "result_document_id"  UUID,
    "due_date"            DATE,
    "completed_at"        TIMESTAMP(3),
    "completed_by_staff"  UUID,
    "notes"               TEXT,
    "created_by_staff"    UUID                   NOT NULL,
    "created_at"          TIMESTAMP(3)           NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMP(3)           NOT NULL,

    CONSTRAINT "dsgvo_request_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "dsgvo_request_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "dsgvo_request_tenant_id_status_idx" ON "dsgvo_request"("tenant_id", "status");
CREATE INDEX "dsgvo_request_tenant_id_type_idx"   ON "dsgvo_request"("tenant_id", "type");
CREATE INDEX "dsgvo_request_tenant_id_due_date_idx" ON "dsgvo_request"("tenant_id", "due_date");

CREATE TABLE "backup_record" (
    "id"          UUID            NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id"   UUID            NOT NULL,
    "started_at"  TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "status"      "backup_status" NOT NULL DEFAULT 'RUNNING',
    "size_bytes"  BIGINT,
    "bucket"      TEXT,
    "key"         TEXT,
    "sha256"      BYTEA,
    "error_msg"   TEXT,

    CONSTRAINT "backup_record_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "backup_record_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "backup_record_tenant_id_started_at_idx" ON "backup_record"("tenant_id", "started_at");
CREATE INDEX "backup_record_tenant_id_status_idx"     ON "backup_record"("tenant_id", "status");

-- RLS
ALTER TABLE "dsgvo_request" ENABLE ROW LEVEL SECURITY;
CREATE POLICY dsgvo_request_isolation ON "dsgvo_request"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

ALTER TABLE "backup_record" ENABLE ROW LEVEL SECURITY;
CREATE POLICY backup_record_isolation ON "backup_record"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "dsgvo_request" TO taxtronik_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "backup_record" TO taxtronik_app;
