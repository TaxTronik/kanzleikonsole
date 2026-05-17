-- =============================================================================
-- Iter. 3: Urlaub & Krankmeldung
-- =============================================================================

CREATE TYPE "vacation_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

CREATE TABLE "vacation_request" (
    "id"            UUID              NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id"     UUID              NOT NULL,
    "staff_id"      UUID              NOT NULL,
    "start_date"    DATE              NOT NULL,
    "end_date"      DATE              NOT NULL,
    "workdays"      INTEGER           NOT NULL,
    "reason"        TEXT,
    "status"        "vacation_status" NOT NULL DEFAULT 'PENDING',
    "decided_by"    UUID,
    "decided_at"    TIMESTAMP(3),
    "decision_note" TEXT,
    "created_at"    TIMESTAMP(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMP(3)      NOT NULL,

    CONSTRAINT "vacation_request_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "vacation_request_staff_id_fkey"
        FOREIGN KEY ("staff_id") REFERENCES "staff_user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "vacation_request_tenant_id_staff_id_start_date_idx" ON "vacation_request"("tenant_id", "staff_id", "start_date");
CREATE INDEX "vacation_request_tenant_id_status_idx" ON "vacation_request"("tenant_id", "status");

CREATE TABLE "sick_leave" (
    "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id"   UUID         NOT NULL,
    "staff_id"    UUID         NOT NULL,
    "start_date"  DATE         NOT NULL,
    "end_date"    DATE,
    "document_id" UUID,
    "notes"       TEXT,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sick_leave_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sick_leave_staff_id_fkey"
        FOREIGN KEY ("staff_id") REFERENCES "staff_user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "sick_leave_document_id_fkey"
        FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "sick_leave_tenant_id_staff_id_start_date_idx" ON "sick_leave"("tenant_id", "staff_id", "start_date");

ALTER TABLE "vacation_request" ENABLE ROW LEVEL SECURITY;
CREATE POLICY vacation_request_isolation ON "vacation_request"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

ALTER TABLE "sick_leave" ENABLE ROW LEVEL SECURITY;
CREATE POLICY sick_leave_isolation ON "sick_leave"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "vacation_request" TO taxtronik_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "sick_leave"       TO taxtronik_app;
