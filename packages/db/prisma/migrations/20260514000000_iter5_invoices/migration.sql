-- =============================================================================
-- Iter. 5: Rechnungen (Invoice + InvoicePosition)
-- XRechnung/ZUGFeRD-Format-Generierung folgt separat (Adapter).
-- =============================================================================

CREATE TYPE "invoice_status" AS ENUM ('DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED');
CREATE TYPE "invoice_format" AS ENUM ('PDF', 'XRECHNUNG', 'ZUGFERD');

CREATE TABLE "invoice" (
    "id"               UUID             NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id"        UUID             NOT NULL,
    "client_id"        UUID             NOT NULL,
    "number"           TEXT             NOT NULL,
    "issue_date"       DATE             NOT NULL,
    "due_date"         DATE             NOT NULL,
    "status"           "invoice_status" NOT NULL DEFAULT 'DRAFT',
    "format"           "invoice_format" NOT NULL DEFAULT 'PDF',
    "subject"          TEXT             NOT NULL,
    "net_amount"       DECIMAL(12,2)    NOT NULL,
    "vat_amount"       DECIMAL(12,2)    NOT NULL,
    "total_amount"     DECIMAL(12,2)    NOT NULL,
    "vat_rate"         DECIMAL(5,2)     NOT NULL,
    "notes"            TEXT,
    "sent_at"          TIMESTAMP(3),
    "paid_at"          TIMESTAMP(3),
    "document_id"      UUID,
    "created_by_staff" UUID             NOT NULL,
    "created_at"       TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"       TIMESTAMP(3)     NOT NULL,

    CONSTRAINT "invoice_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "invoice_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "invoice_client_id_fkey"
        FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "invoice_document_id_fkey"
        FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "invoice_tenant_id_number_key" ON "invoice"("tenant_id", "number");
CREATE INDEX "invoice_tenant_id_status_idx"   ON "invoice"("tenant_id", "status");
CREATE INDEX "invoice_tenant_id_client_id_idx" ON "invoice"("tenant_id", "client_id");
CREATE INDEX "invoice_tenant_id_due_date_idx"  ON "invoice"("tenant_id", "due_date");

CREATE TABLE "invoice_position" (
    "id"          UUID          NOT NULL DEFAULT gen_random_uuid(),
    "invoice_id"  UUID          NOT NULL,
    "position"    INTEGER       NOT NULL,
    "description" TEXT          NOT NULL,
    "quantity"    DECIMAL(10,2) NOT NULL,
    "unit_price"  DECIMAL(10,2) NOT NULL,
    "unit"        TEXT          NOT NULL DEFAULT 'Stück',
    "net_amount"  DECIMAL(12,2) NOT NULL,

    CONSTRAINT "invoice_position_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "invoice_position_invoice_id_fkey"
        FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "invoice_position_invoice_id_position_key" ON "invoice_position"("invoice_id", "position");

ALTER TABLE "invoice" ENABLE ROW LEVEL SECURITY;
CREATE POLICY invoice_isolation ON "invoice"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

ALTER TABLE "invoice_position" ENABLE ROW LEVEL SECURITY;
CREATE POLICY invoice_position_isolation ON "invoice_position"
    USING (EXISTS (
        SELECT 1 FROM "invoice" i
        WHERE i.id = "invoice_position"."invoice_id"
          AND i.tenant_id = app.current_tenant_id()
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM "invoice" i
        WHERE i.id = "invoice_position"."invoice_id"
          AND i.tenant_id = app.current_tenant_id()
    ));

-- GwG-Schranke für Rechnungen analog Document/Request: nur an aktive Mandanten
CREATE OR REPLACE FUNCTION app.enforce_client_active_for_invoice() RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM "client" c
        WHERE c.id = NEW.client_id AND c.allow_active = TRUE
    ) THEN
        RAISE EXCEPTION 'Mandant % ist nicht aktiv (GwG-Schranke). Rechnungsanlage abgewiesen.',
            NEW.client_id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER invoice_client_active_check
    BEFORE INSERT ON "invoice"
    FOR EACH ROW EXECUTE FUNCTION app.enforce_client_active_for_invoice();

GRANT SELECT, INSERT, UPDATE, DELETE ON "invoice"          TO taxtronik_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "invoice_position" TO taxtronik_app;
