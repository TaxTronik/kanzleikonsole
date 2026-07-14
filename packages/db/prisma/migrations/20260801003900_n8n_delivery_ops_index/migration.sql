-- Supports tenant-scoped, status-filtered keyset pagination in the n8n
-- operations UI (especially the complete list of open FAILED deliveries).
CREATE INDEX "n8n_delivery_tenant_status_created_id_idx"
    ON "n8n_delivery"("tenant_id", "status", "created_at", "id");
