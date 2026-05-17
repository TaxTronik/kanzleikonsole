-- =============================================================================
-- Iter. 5: Vollmachten (PowerOfAttorney) — eIDAS AES via Token + OTP
-- =============================================================================

CREATE TYPE "poa_status" AS ENUM ('DRAFT', 'SENT', 'SIGNED', 'REVOKED', 'EXPIRED');

CREATE TABLE "power_of_attorney" (
    "id"                       UUID         NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id"                UUID         NOT NULL,
    "client_id"                UUID         NOT NULL,
    "signer_contact_id"        UUID,
    "signer_email"             CITEXT       NOT NULL,
    "signer_name"              TEXT         NOT NULL,
    "subject"                  TEXT         NOT NULL,
    "scope"                    TEXT         NOT NULL,
    "valid_from"               DATE         NOT NULL,
    "valid_until"              DATE,
    "status"                   "poa_status" NOT NULL DEFAULT 'DRAFT',
    "signing_token_hash"       TEXT,
    "signing_token_expires_at" TIMESTAMP(3),
    "signing_otp_hash"         TEXT,
    "signing_otp_expires_at"   TIMESTAMP(3),
    "signed_at"                TIMESTAMP(3),
    "signed_by_ip"             INET,
    "signed_by_user_agent"     TEXT,
    "document_id"              UUID,
    "created_by_staff"         UUID         NOT NULL,
    "revoked_at"               TIMESTAMP(3),
    "revoked_reason"           TEXT,
    "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"               TIMESTAMP(3) NOT NULL,

    CONSTRAINT "power_of_attorney_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "power_of_attorney_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "power_of_attorney_client_id_fkey"
        FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "power_of_attorney_tenant_id_client_id_idx" ON "power_of_attorney"("tenant_id", "client_id");
CREATE INDEX "power_of_attorney_tenant_id_status_idx" ON "power_of_attorney"("tenant_id", "status");
CREATE INDEX "power_of_attorney_signing_token_hash_idx" ON "power_of_attorney"("signing_token_hash");

ALTER TABLE "power_of_attorney" ENABLE ROW LEVEL SECURITY;
CREATE POLICY power_of_attorney_isolation ON "power_of_attorney"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "power_of_attorney" TO taxtronik_app;
