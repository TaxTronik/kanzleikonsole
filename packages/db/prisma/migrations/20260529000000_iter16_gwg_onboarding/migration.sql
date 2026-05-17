-- =============================================================================
-- Iter. 16: GwG-Onboarding-Einladung
-- =============================================================================

CREATE TYPE "gwg_invite_status" AS ENUM (
  'PENDING','STARTED','SUBMITTED','EXPIRED','CANCELLED'
);

CREATE TABLE "gwg_onboarding_invite" (
  "id"                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"           UUID NOT NULL,
  "client_id"           UUID NOT NULL,
  "invite_email"        CITEXT NOT NULL,
  "invite_name"         TEXT NOT NULL,
  "token_hash"          TEXT NOT NULL,
  "expires_at"          TIMESTAMP(3) NOT NULL,
  "status"              "gwg_invite_status" NOT NULL DEFAULT 'PENDING',
  "submitted_at"        TIMESTAMP(3),
  "submitted_ip"        INET,
  "submitted_ua"        TEXT,
  "gwg_check_id"        UUID,
  "created_by_staff"    UUID NOT NULL,
  "cancelled_by_staff"  UUID,
  "cancelled_at"        TIMESTAMP(3),
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "gwg_invite_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE,
  CONSTRAINT "gwg_invite_client_fkey"
    FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE CASCADE
);

CREATE INDEX "gwg_invite_tenant_id_client_id_status_idx"
  ON "gwg_onboarding_invite"("tenant_id","client_id","status");
CREATE INDEX "gwg_invite_token_hash_idx" ON "gwg_onboarding_invite"("token_hash");

ALTER TABLE "gwg_onboarding_invite" ENABLE ROW LEVEL SECURITY;
CREATE POLICY gwg_invite_isolation ON "gwg_onboarding_invite"
  USING ("tenant_id" = app.current_tenant_id())
  WITH CHECK ("tenant_id" = app.current_tenant_id());
