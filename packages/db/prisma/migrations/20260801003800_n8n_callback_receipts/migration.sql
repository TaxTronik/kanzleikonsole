-- Durable idempotency for n8n -> TaxTronik write callbacks. A receipt is
-- inserted in the same transaction as the business mutation. Consequently a
-- visible row always represents a fully committed callback.

CREATE TABLE "n8n_callback_receipt" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "request_id_hash" VARCHAR(64) NOT NULL,
    "operation" VARCHAR(64) NOT NULL,
    "result_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "n8n_callback_receipt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "n8n_callback_receipt_hash_check"
        CHECK ("request_id_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "n8n_callback_receipt_operation_check"
        CHECK ("operation" IN ('request-inbound', 'research-result'))
);

CREATE UNIQUE INDEX "n8n_callback_receipt_connection_request_key"
    ON "n8n_callback_receipt"("connection_id", "request_id_hash");
CREATE INDEX "n8n_callback_receipt_tenant_created_idx"
    ON "n8n_callback_receipt"("tenant_id", "created_at");

ALTER TABLE "n8n_callback_receipt"
    ADD CONSTRAINT "n8n_callback_receipt_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "n8n_callback_receipt"
    ADD CONSTRAINT "n8n_callback_receipt_connection_fkey"
    FOREIGN KEY ("connection_id", "tenant_id")
    REFERENCES "n8n_connection"("id", "tenant_id")
    ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "n8n_callback_receipt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "n8n_callback_receipt" FORCE ROW LEVEL SECURITY;
CREATE POLICY n8n_callback_receipt_isolation ON "n8n_callback_receipt"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON "n8n_callback_receipt" TO taxtronik_app;
