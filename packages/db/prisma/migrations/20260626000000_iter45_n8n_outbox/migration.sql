-- =============================================================================
-- Iter 45 — n8n Outbox-Pattern (S15)
--
-- Bisher: emitN8nEvent ist fire-and-forget — bei n8n-Ausfall gehen Events
-- verloren (siehe ADR 0011). Reicht für pull-basierte Workflows, NICHT für
-- push-only-Events.
--
-- Outbox-Pattern: jede emit speichert eine Reihe, ein BullMQ-Worker delivered
-- mit Exponential-Backoff. Bei dauerhaftem Fehlschlag bleibt die Reihe mit
-- status=FAILED erhalten und kann manuell re-triggered werden.
-- =============================================================================

CREATE TYPE "N8nOutboxStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED');

CREATE TABLE "n8n_outbox" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "status" "N8nOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "last_error" TEXT,
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "n8n_outbox_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "n8n_outbox_status_created_at_idx" ON "n8n_outbox" ("status", "created_at");
CREATE INDEX "n8n_outbox_tenant_id_idx" ON "n8n_outbox" ("tenant_id");

ALTER TABLE "n8n_outbox" ADD CONSTRAINT "n8n_outbox_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: nur für tenant-bezogene Events ist RLS relevant. System-Events
-- (tenant_id IS NULL) sollen nur Owner sehen. App-Role darf:
--  - eigene tenant-events lesen/schreiben
--  - System-events NICHT sehen
ALTER TABLE "n8n_outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "n8n_outbox" FORCE ROW LEVEL SECURITY;

CREATE POLICY n8n_outbox_isolation ON "n8n_outbox"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id() OR "tenant_id" IS NULL);
