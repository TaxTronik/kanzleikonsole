-- =============================================================================
-- Iter. 6: BWA / Auswertungen
-- =============================================================================

CREATE TYPE "bwa_period_type" AS ENUM ('YEAR', 'QUARTER', 'MONTH');
CREATE TYPE "bwa_source"      AS ENUM ('ADDISON', 'DATEV', 'MANUAL');

CREATE TABLE "bwa_period" (
    "id"             UUID              NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id"      UUID              NOT NULL,
    "client_id"      UUID              NOT NULL,
    "period_type"    "bwa_period_type" NOT NULL,
    "period_key"     TEXT              NOT NULL,
    "from_date"      DATE              NOT NULL,
    "to_date"        DATE              NOT NULL,
    "source"         "bwa_source"      NOT NULL,
    "source_ref"     TEXT,
    "imported_by_id" UUID              NOT NULL,
    "created_at"     TIMESTAMP(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bwa_period_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "bwa_period_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "bwa_period_client_id_fkey"
        FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "bwa_period_tenant_id_client_id_period_key_key"
    ON "bwa_period"("tenant_id", "client_id", "period_key");
CREATE INDEX "bwa_period_tenant_id_client_id_from_date_idx"
    ON "bwa_period"("tenant_id", "client_id", "from_date");

CREATE TABLE "bwa_position" (
    "id"        UUID          NOT NULL DEFAULT gen_random_uuid(),
    "period_id" UUID          NOT NULL,
    "number"    INTEGER       NOT NULL,
    "label"     TEXT          NOT NULL,
    "amount"    DECIMAL(14,2) NOT NULL,
    "share_pct" DECIMAL(5,2),

    CONSTRAINT "bwa_position_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "bwa_position_period_id_fkey"
        FOREIGN KEY ("period_id") REFERENCES "bwa_period"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "bwa_position_period_id_number_key" ON "bwa_position"("period_id", "number");
CREATE INDEX "bwa_position_period_id_idx" ON "bwa_position"("period_id");

ALTER TABLE "bwa_period" ENABLE ROW LEVEL SECURITY;
CREATE POLICY bwa_period_isolation ON "bwa_period"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

ALTER TABLE "bwa_position" ENABLE ROW LEVEL SECURITY;
CREATE POLICY bwa_position_isolation ON "bwa_position"
    USING (EXISTS (
        SELECT 1 FROM "bwa_period" p
        WHERE p.id = "bwa_position"."period_id"
          AND p.tenant_id = app.current_tenant_id()
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM "bwa_period" p
        WHERE p.id = "bwa_position"."period_id"
          AND p.tenant_id = app.current_tenant_id()
    ));

GRANT SELECT, INSERT, UPDATE, DELETE ON "bwa_period"   TO taxtronik_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "bwa_position" TO taxtronik_app;
