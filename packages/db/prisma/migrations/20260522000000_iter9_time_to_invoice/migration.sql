-- =============================================================================
-- Iter. 9: Time-to-Invoice — TimeEntry um invoice_id und hourly_rate erweitern
-- =============================================================================

ALTER TABLE "time_entry"
    ADD COLUMN "invoice_id"  UUID,
    ADD COLUMN "hourly_rate" DECIMAL(10,2);

ALTER TABLE "time_entry"
    ADD CONSTRAINT "time_entry_invoice_id_fkey"
        FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "time_entry_tenant_id_client_id_billable_invoice_id_idx"
    ON "time_entry"("tenant_id", "client_id", "billable", "invoice_id");
