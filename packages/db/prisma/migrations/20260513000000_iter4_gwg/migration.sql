-- =============================================================================
-- Iter. 4: GwG-Compliance
--   - gwg_check (Hauptdatensatz pro Mandant + Wiederholungsprüfung)
--   - gwg_id_document (Personalausweis, Reisepass, Handelsregisterauszug …)
--   - gwg_beneficial_owner (wirtschaftlich Berechtigte)
--   - service_provider (Dienstleisterverzeichnis nach § 11 GwG / DSGVO Art. 28)
--   - Invarianten-Trigger: client.allow_active = TRUE ist NUR möglich,
--     wenn mindestens 1 VERIFIED-gwg_check existiert (mit gültigem valid_until)
-- =============================================================================

-- 1. Enums --------------------------------------------------------------------
CREATE TYPE "gwg_status"           AS ENUM ('DRAFT', 'IN_REVIEW', 'VERIFIED', 'REJECTED', 'EXPIRED');
CREATE TYPE "gwg_risk_level"       AS ENUM ('LOW', 'MEDIUM', 'HIGH');
CREATE TYPE "gwg_id_document_type" AS ENUM (
    'PERSONALAUSWEIS', 'REISEPASS', 'HANDELSREGISTERAUSZUG',
    'GESELLSCHAFTSVERTRAG', 'VOLLMACHT', 'TRANSPARENZREGISTER_AUSZUG', 'SONSTIGES'
);

-- 2. Tabellen -----------------------------------------------------------------

CREATE TABLE "gwg_check" (
    "id"              UUID              NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id"       UUID              NOT NULL,
    "client_id"       UUID              NOT NULL,
    "status"          "gwg_status"      NOT NULL DEFAULT 'DRAFT',
    "risk_level"      "gwg_risk_level",
    "risk_score"      INTEGER,
    "risk_breakdown"  JSONB,
    "risk_answers"    JSONB,
    "valid_until"     TIMESTAMP(3),
    "verified_at"     TIMESTAMP(3),
    "verified_by"     UUID,
    "rejected_reason" TEXT,
    "notes"           TEXT,
    "created_at"      TIMESTAMP(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3)      NOT NULL,

    CONSTRAINT "gwg_check_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "gwg_check_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "gwg_check_client_id_fkey"
        FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "gwg_check_tenant_id_client_id_idx" ON "gwg_check"("tenant_id", "client_id");
CREATE INDEX "gwg_check_tenant_id_status_idx"    ON "gwg_check"("tenant_id", "status");

CREATE TABLE "gwg_id_document" (
    "id"           UUID                    NOT NULL DEFAULT gen_random_uuid(),
    "gwg_check_id" UUID                    NOT NULL,
    "type"         "gwg_id_document_type"  NOT NULL,
    "owner_name"   TEXT                    NOT NULL,
    "document_id"  UUID,
    "number"       TEXT,
    "issued_by"    TEXT,
    "issue_date"   DATE,
    "expiry_date"  DATE,
    "verified_at"  TIMESTAMP(3),
    "notes"        TEXT,
    "created_at"   TIMESTAMP(3)            NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gwg_id_document_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "gwg_id_document_gwg_check_id_fkey"
        FOREIGN KEY ("gwg_check_id") REFERENCES "gwg_check"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "gwg_id_document_document_id_fkey"
        FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "gwg_id_document_gwg_check_id_idx" ON "gwg_id_document"("gwg_check_id");

CREATE TABLE "gwg_beneficial_owner" (
    "id"            UUID         NOT NULL DEFAULT gen_random_uuid(),
    "gwg_check_id"  UUID         NOT NULL,
    "full_name"     TEXT         NOT NULL,
    "birth_date"    DATE,
    "birth_place"   TEXT,
    "residence"     TEXT,
    "nationality"   TEXT,
    "ownership_pct" DECIMAL(5,2),
    "is_pep"        BOOLEAN      NOT NULL DEFAULT FALSE,
    "notes"         TEXT,
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gwg_beneficial_owner_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "gwg_beneficial_owner_gwg_check_id_fkey"
        FOREIGN KEY ("gwg_check_id") REFERENCES "gwg_check"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "gwg_beneficial_owner_gwg_check_id_idx" ON "gwg_beneficial_owner"("gwg_check_id");

CREATE TABLE "service_provider" (
    "id"                 UUID         NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id"          UUID         NOT NULL,
    "name"               TEXT         NOT NULL,
    "category"           TEXT         NOT NULL,
    "has_data_access"    BOOLEAN      NOT NULL DEFAULT FALSE,
    "contact_email"      TEXT,
    "contract_from_date" DATE,
    "contract_to_date"   DATE,
    "notes"              TEXT,
    "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_provider_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "service_provider_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "service_provider_tenant_id_idx" ON "service_provider"("tenant_id");

-- 3. RLS-Policies -------------------------------------------------------------

ALTER TABLE "gwg_check" ENABLE ROW LEVEL SECURITY;
CREATE POLICY gwg_check_isolation ON "gwg_check"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

ALTER TABLE "gwg_id_document" ENABLE ROW LEVEL SECURITY;
CREATE POLICY gwg_id_document_isolation ON "gwg_id_document"
    USING (EXISTS (
        SELECT 1 FROM "gwg_check" gc
        WHERE gc.id = "gwg_id_document"."gwg_check_id"
          AND gc.tenant_id = app.current_tenant_id()
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM "gwg_check" gc
        WHERE gc.id = "gwg_id_document"."gwg_check_id"
          AND gc.tenant_id = app.current_tenant_id()
    ));

ALTER TABLE "gwg_beneficial_owner" ENABLE ROW LEVEL SECURITY;
CREATE POLICY gwg_beneficial_owner_isolation ON "gwg_beneficial_owner"
    USING (EXISTS (
        SELECT 1 FROM "gwg_check" gc
        WHERE gc.id = "gwg_beneficial_owner"."gwg_check_id"
          AND gc.tenant_id = app.current_tenant_id()
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM "gwg_check" gc
        WHERE gc.id = "gwg_beneficial_owner"."gwg_check_id"
          AND gc.tenant_id = app.current_tenant_id()
    ));

ALTER TABLE "service_provider" ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_provider_isolation ON "service_provider"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

-- 4. Invarianten-Trigger: client.allow_active darf nur TRUE sein,
--    wenn mindestens ein VERIFIED + nicht-EXPIRED gwg_check existiert.
--    (Iter. 1 hatte allow_active manuell gesetzt — jetzt durch Compliance gesichert.)
CREATE OR REPLACE FUNCTION app.enforce_client_allow_active_requires_gwg() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.allow_active = TRUE THEN
        IF NOT EXISTS (
            SELECT 1 FROM "gwg_check" gc
            WHERE gc.client_id = NEW.id
              AND gc.status    = 'VERIFIED'
              AND (gc.valid_until IS NULL OR gc.valid_until > now())
        ) THEN
            RAISE EXCEPTION 'client.allow_active=TRUE erfordert einen gültigen, verifizierten gwg_check (Mandant: %)',
                NEW.id
                USING ERRCODE = 'check_violation',
                      HINT    = 'Erst gwg_check anlegen, Risiko bewerten, Belege prüfen, dann verify.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER client_allow_active_requires_gwg
    BEFORE UPDATE OF allow_active ON "client"
    FOR EACH ROW
    WHEN (NEW.allow_active = TRUE AND OLD.allow_active IS DISTINCT FROM NEW.allow_active)
    EXECUTE FUNCTION app.enforce_client_allow_active_requires_gwg();

-- 5. GRANTs für App-Role ------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON "gwg_check"            TO taxtronik_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "gwg_id_document"      TO taxtronik_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "gwg_beneficial_owner" TO taxtronik_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "service_provider"     TO taxtronik_app;
