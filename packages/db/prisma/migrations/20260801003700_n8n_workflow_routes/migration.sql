-- =============================================================================
-- n8n: benannte Instanz, workflow-spezifische Webhooks und Zustellstatus
--
-- Additiv und rolling-deploy-fähig: n8n_outbox bleibt das logische Event. Die
-- neuen n8n_delivery-Reihen bilden den Fan-out auf konkrete Endpoints ab. Alte
-- Queue-Jobs mit nur outbox_id werden vom neuen Worker weiterhin akzeptiert.
-- =============================================================================

ALTER TYPE "N8nOutboxStatus" ADD VALUE IF NOT EXISTS 'PARTIAL';
ALTER TYPE "N8nOutboxStatus" ADD VALUE IF NOT EXISTS 'UNROUTED';
ALTER TYPE "N8nOutboxStatus" ADD VALUE IF NOT EXISTS 'SKIPPED';

-- Beschleunigt die tägliche, nach Terminalstatus und updated_at begrenzte
-- Retention ohne einen Full-Table-Scan der technischen Ereignishistorie.
CREATE INDEX "n8n_outbox_status_updated_idx" ON "n8n_outbox"("status", "updated_at");

CREATE TYPE "N8nConnectionKind" AS ENUM ('BUNDLED', 'SELF_HOSTED', 'CLOUD');
CREATE TYPE "N8nRoutingMode" AS ENUM ('DISABLED', 'LEGACY', 'EXPLICIT');
CREATE TYPE "N8nEndpointSource" AS ENUM ('MANAGED', 'DISCOVERED', 'CUSTOM', 'LEGACY');
CREATE TYPE "N8nDeliveryStatus" AS ENUM ('PENDING', 'PROCESSING', 'DELIVERED', 'FAILED', 'SKIPPED');

CREATE TABLE "n8n_connection" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "N8nConnectionKind" NOT NULL DEFAULT 'BUNDLED',
    "routing_mode" "N8nRoutingMode" NOT NULL DEFAULT 'LEGACY',
    "ui_base_url" TEXT,
    "api_base_url" TEXT,
    "webhook_base_url" TEXT,
    "callback_base_url" TEXT,
    "api_key_encrypted" TEXT,
    "signing_secret_encrypted" TEXT,
    "callback_key_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "callback_token_hash" TEXT,
    "callback_scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "health_checked_at" TIMESTAMPTZ(6),
    "health_ok" BOOLEAN,
    "health_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "n8n_connection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "n8n_connection_tenant_id_key" ON "n8n_connection"("tenant_id");
CREATE UNIQUE INDEX "n8n_connection_callback_key_id_key" ON "n8n_connection"("callback_key_id");
CREATE UNIQUE INDEX "n8n_connection_id_tenant_key" ON "n8n_connection"("id", "tenant_id");

CREATE TABLE "n8n_webhook_endpoint" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "production_url" TEXT NOT NULL,
    "test_url" TEXT,
    "workflow_id" TEXT,
    "workflow_name" TEXT,
    "workflow_node_id" TEXT,
    "source" "N8nEndpointSource" NOT NULL DEFAULT 'CUSTOM',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "verified_at" TIMESTAMPTZ(6),
    "verification_ok" BOOLEAN,
    "verification_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "n8n_webhook_endpoint_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "n8n_webhook_endpoint_production_not_test_check"
        CHECK ("production_url" !~* '/webhook-test(/|$|[?#])')
);

CREATE UNIQUE INDEX "n8n_webhook_endpoint_id_tenant_key" ON "n8n_webhook_endpoint"("id", "tenant_id");
CREATE UNIQUE INDEX "n8n_webhook_endpoint_connection_name_key" ON "n8n_webhook_endpoint"("connection_id", "name");
CREATE INDEX "n8n_webhook_endpoint_tenant_enabled_idx" ON "n8n_webhook_endpoint"("tenant_id", "enabled");

CREATE TABLE "n8n_event_subscription" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "event" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "n8n_event_subscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "n8n_event_subscription_endpoint_event_key" ON "n8n_event_subscription"("endpoint_id", "event");
CREATE INDEX "n8n_event_subscription_route_idx" ON "n8n_event_subscription"("tenant_id", "event", "enabled");

CREATE TABLE "n8n_delivery" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID,
    "outbox_id" UUID NOT NULL,
    "endpoint_id" UUID,
    "connection_id_snapshot" UUID,
    "endpoint_name_snapshot" TEXT NOT NULL,
    "target_url" TEXT,
    "status" "N8nDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "lease_token" UUID,
    "lease_expires_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "http_status" INTEGER,
    "latency_ms" INTEGER,
    "last_error" TEXT,
    "first_attempt_at" TIMESTAMPTZ(6),
    "last_attempt_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "n8n_delivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "n8n_delivery_outbox_endpoint_key" ON "n8n_delivery"("outbox_id", "endpoint_id");
CREATE INDEX "n8n_delivery_status_created_idx" ON "n8n_delivery"("status", "created_at");
CREATE INDEX "n8n_delivery_status_lease_idx" ON "n8n_delivery"("status", "lease_expires_at");
CREATE INDEX "n8n_delivery_tenant_created_idx" ON "n8n_delivery"("tenant_id", "created_at");
CREATE INDEX "n8n_delivery_endpoint_status_idx" ON "n8n_delivery"("endpoint_id", "status");

ALTER TABLE "n8n_connection" ADD CONSTRAINT "n8n_connection_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "n8n_webhook_endpoint" ADD CONSTRAINT "n8n_webhook_endpoint_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "n8n_webhook_endpoint" ADD CONSTRAINT "n8n_webhook_endpoint_connection_fkey"
    FOREIGN KEY ("connection_id", "tenant_id") REFERENCES "n8n_connection"("id", "tenant_id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "n8n_event_subscription" ADD CONSTRAINT "n8n_event_subscription_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "n8n_event_subscription" ADD CONSTRAINT "n8n_event_subscription_endpoint_fkey"
    FOREIGN KEY ("endpoint_id", "tenant_id") REFERENCES "n8n_webhook_endpoint"("id", "tenant_id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "n8n_delivery" ADD CONSTRAINT "n8n_delivery_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "n8n_delivery" ADD CONSTRAINT "n8n_delivery_outbox_fkey"
    FOREIGN KEY ("outbox_id") REFERENCES "n8n_outbox"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "n8n_delivery" ADD CONSTRAINT "n8n_delivery_endpoint_fkey"
    FOREIGN KEY ("endpoint_id", "tenant_id") REFERENCES "n8n_webhook_endpoint"("id", "tenant_id") ON DELETE SET NULL ("endpoint_id") ON UPDATE NO ACTION;

-- Tenant-Isolation. App-Rollen sehen/schreiben ausschließlich Reihen ihres
-- aktuellen Tenant-Kontexts. NULL-System-Deliveries bleiben Owner-only.
ALTER TABLE "n8n_connection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "n8n_connection" FORCE ROW LEVEL SECURITY;
CREATE POLICY n8n_connection_isolation ON "n8n_connection"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

ALTER TABLE "n8n_webhook_endpoint" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "n8n_webhook_endpoint" FORCE ROW LEVEL SECURITY;
CREATE POLICY n8n_webhook_endpoint_isolation ON "n8n_webhook_endpoint"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

ALTER TABLE "n8n_event_subscription" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "n8n_event_subscription" FORCE ROW LEVEL SECURITY;
CREATE POLICY n8n_event_subscription_isolation ON "n8n_event_subscription"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

ALTER TABLE "n8n_delivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "n8n_delivery" FORCE ROW LEVEL SECURITY;
CREATE POLICY n8n_delivery_isolation ON "n8n_delivery"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

-- Die Settings-/Status-Oberfläche arbeitet mit der RLS-gebundenen App-Rolle.
-- Outbox-Erzeugung bleibt bewusst Owner-only; die App braucht dort nur Lesen
-- und den expliziten manuellen Retry-Statuswechsel.
GRANT SELECT, UPDATE ON "n8n_outbox" TO taxtronik_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "n8n_connection" TO taxtronik_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "n8n_webhook_endpoint" TO taxtronik_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "n8n_event_subscription" TO taxtronik_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "n8n_delivery" TO taxtronik_app;
