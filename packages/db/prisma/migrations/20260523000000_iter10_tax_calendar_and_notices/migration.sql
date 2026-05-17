-- =============================================================================
-- Iter. 10: Steuertermin-Kalender + Bescheid-Postfach
--
-- Drei neue Tabellen:
--   - tax_schedule_config: pro Mandant aktivierte Termin-Arten
--   - tax_deadline:       materialisierte Termine mit Status
--   - tax_notice:         eingegangene Bescheide vom FA mit Soll/Ist
--
-- RLS: tenant_id-Isolation auf allen drei Tabellen.
-- =============================================================================

-- Enums
CREATE TYPE "tax_schedule_kind" AS ENUM (
    'USTA_MONATLICH','USTA_QUARTAL','USTA_JAEHRLICH',
    'LSTA_MONATLICH','LSTA_QUARTAL','LSTA_JAEHRLICH',
    'EST_VZ','KST_VZ','GEWST_VZ',
    'EST_ERKLAERUNG','KST_ERKLAERUNG','GEWST_ERKLAERUNG'
);

CREATE TYPE "tax_deadline_status" AS ENUM (
    'PLANNED','REMINDED','IN_PROGRESS','SUBMITTED','DONE','OVERDUE','SKIPPED'
);

CREATE TYPE "tax_notice_kind" AS ENUM (
    'USTA','UST_JAHR','EST','KST','GEWST_MESSBESCHEID','GEWST',
    'LSTA','FESTSTELLUNG','ZERLEGUNG','SONSTIGE'
);

CREATE TYPE "tax_notice_status" AS ENUM (
    'NEU','GEPRUEFT','EINSPRUCH','ABGEHOLFEN','ZURUECKGEWIESEN','RECHTSKRAEFTIG'
);

-- ----------------------------------------------------------------------------
-- tax_schedule_config
-- ----------------------------------------------------------------------------

CREATE TABLE "tax_schedule_config" (
    "id"                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id"            UUID NOT NULL,
    "client_id"            UUID NOT NULL,
    "kind"                 "tax_schedule_kind" NOT NULL,
    "active"               BOOLEAN NOT NULL DEFAULT TRUE,
    "has_dauerfrist"       BOOLEAN NOT NULL DEFAULT FALSE,
    "reminder_days_before" INT NOT NULL DEFAULT 10,
    "notes"                TEXT,
    "created_by_staff"     UUID NOT NULL,
    "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"           TIMESTAMP(3) NOT NULL,
    CONSTRAINT "tax_schedule_config_tenant_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE,
    CONSTRAINT "tax_schedule_config_client_fkey"
        FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "tax_schedule_config_tenant_id_client_id_kind_key"
    ON "tax_schedule_config"("tenant_id","client_id","kind");

CREATE INDEX "tax_schedule_config_tenant_id_client_id_idx"
    ON "tax_schedule_config"("tenant_id","client_id");

ALTER TABLE "tax_schedule_config" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tax_schedule_config_isolation ON "tax_schedule_config"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

-- ----------------------------------------------------------------------------
-- tax_deadline
-- ----------------------------------------------------------------------------

CREATE TABLE "tax_deadline" (
    "id"                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id"           UUID NOT NULL,
    "client_id"           UUID NOT NULL,
    "config_id"           UUID,
    "kind"                "tax_schedule_kind" NOT NULL,
    "period"              TEXT NOT NULL,
    "due_date"            DATE NOT NULL,
    "status"              "tax_deadline_status" NOT NULL DEFAULT 'PLANNED',
    "request_id"          UUID,
    "amount_due"          DECIMAL(12,2),
    "notes"               TEXT,
    "completed_at"        TIMESTAMP(3),
    "completed_by_staff"  UUID,
    "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMP(3) NOT NULL,
    CONSTRAINT "tax_deadline_tenant_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE,
    CONSTRAINT "tax_deadline_client_fkey"
        FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE CASCADE,
    CONSTRAINT "tax_deadline_config_fkey"
        FOREIGN KEY ("config_id") REFERENCES "tax_schedule_config"("id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX "tax_deadline_tenant_id_client_id_kind_period_key"
    ON "tax_deadline"("tenant_id","client_id","kind","period");

CREATE INDEX "tax_deadline_tenant_id_due_date_idx"
    ON "tax_deadline"("tenant_id","due_date");

CREATE INDEX "tax_deadline_tenant_id_status_due_date_idx"
    ON "tax_deadline"("tenant_id","status","due_date");

ALTER TABLE "tax_deadline" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tax_deadline_isolation ON "tax_deadline"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

-- ----------------------------------------------------------------------------
-- tax_notice
-- ----------------------------------------------------------------------------

CREATE TABLE "tax_notice" (
    "id"                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id"          UUID NOT NULL,
    "client_id"          UUID NOT NULL,
    "kind"               "tax_notice_kind" NOT NULL,
    "period"             TEXT NOT NULL,
    "notice_date"        DATE NOT NULL,
    "appeal_deadline"    DATE,
    "status"             "tax_notice_status" NOT NULL DEFAULT 'NEU',
    "file_number"        TEXT,
    "assessed_amount"    DECIMAL(12,2),
    "prepaid_amount"     DECIMAL(12,2),
    "refund_amount"      DECIMAL(12,2),
    "pay_amount"         DECIMAL(12,2),
    "expected_amount"    DECIMAL(12,2),
    "review_notes"       TEXT,
    "reviewed_at"        TIMESTAMP(3),
    "reviewed_by"        UUID,
    "appeal_filed_at"    TIMESTAMP(3),
    "appeal_reason"      TEXT,
    "appeal_resolved_at" TIMESTAMP(3),
    "document_id"        UUID,
    "deadline_id"        UUID,
    "created_by_staff"   UUID NOT NULL,
    "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"         TIMESTAMP(3) NOT NULL,
    CONSTRAINT "tax_notice_tenant_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE,
    CONSTRAINT "tax_notice_client_fkey"
        FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE CASCADE,
    CONSTRAINT "tax_notice_document_fkey"
        FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX "tax_notice_tenant_id_client_id_kind_period_key"
    ON "tax_notice"("tenant_id","client_id","kind","period");

CREATE INDEX "tax_notice_tenant_id_client_id_idx"
    ON "tax_notice"("tenant_id","client_id");

CREATE INDEX "tax_notice_tenant_id_status_appeal_deadline_idx"
    ON "tax_notice"("tenant_id","status","appeal_deadline");

ALTER TABLE "tax_notice" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tax_notice_isolation ON "tax_notice"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

-- ----------------------------------------------------------------------------
-- Trigger: appeal_deadline automatisch berechnen
-- (notice_date + 33 Tage = Bekanntgabefiktion 3 Tage + 1 Monat Einspruchsfrist)
-- Wenn der App-Code es nicht setzt — Sicherungs-Default.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.tax_notice_set_appeal_deadline() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.appeal_deadline IS NULL THEN
    NEW.appeal_deadline := NEW.notice_date + INTERVAL '33 days';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tax_notice_appeal_deadline_trigger
  BEFORE INSERT OR UPDATE OF notice_date ON "tax_notice"
  FOR EACH ROW EXECUTE FUNCTION app.tax_notice_set_appeal_deadline();
