-- TAX-MASTER-DATA-001, GWG-REVERIFICATION-VALIDITY-001, GWG-SELF-ONBOARDING-001.
-- Deploy with old application writers stopped. Never recalculate historical hashes.
BEGIN;

CREATE UNIQUE INDEX "client_tenant_id_id_key" ON "client"("tenant_id", "id");
CREATE TABLE "client_tax_registration" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "client_id" UUID NOT NULL,
  "label" TEXT NOT NULL,
  "state_code" TEXT,
  "number_elster" TEXT,
  "tax_office_name" TEXT NOT NULL DEFAULT '',
  "tax_office_code" TEXT,
  "is_primary" BOOLEAN NOT NULL DEFAULT FALSE,
  "archived_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "client_tax_registration_number_check" CHECK ("number_elster" ~ '^[0-9]{13}$'),
  CONSTRAINT "client_tax_registration_office_check" CHECK (("number_elster" IS NULL AND "tax_office_code" IS NULL) OR ("number_elster" IS NOT NULL AND "tax_office_code" IS NOT NULL AND "tax_office_code" = left("number_elster", 4))),
  CONSTRAINT "client_tax_registration_active_number_check" CHECK ("archived_at" IS NOT NULL OR "number_elster" IS NOT NULL),
  CONSTRAINT "client_tax_registration_archive_check" CHECK ("archived_at" IS NULL OR NOT "is_primary"),
  CONSTRAINT "client_tax_registration_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "client_tax_registration_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "client"("tenant_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "client_tax_registration_tenant_id_client_id_id_key" ON "client_tax_registration"("tenant_id", "client_id", "id");
CREATE INDEX "client_tax_registration_tenant_id_client_id_idx" ON "client_tax_registration"("tenant_id", "client_id");
CREATE UNIQUE INDEX "client_tax_registration_primary_idx" ON "client_tax_registration"("client_id") WHERE "is_primary" AND "archived_at" IS NULL;
CREATE UNIQUE INDEX "client_tax_registration_active_number_idx" ON "client_tax_registration"("client_id", "number_elster") WHERE "archived_at" IS NULL;
CREATE TRIGGER "00_tenant_client_pair_integrity"
  BEFORE INSERT OR UPDATE OF "tenant_id", "client_id" ON "client_tax_registration"
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant_client_pair_integrity();

-- Existing number is copied verbatim; no inferred tax type or office name.
-- DSGVO-MANDATE-ANONYMIZATION-001: old anonymized skeletons must not regain tax data.
UPDATE "client" SET "steuernummer" = NULL WHERE "kind" = 'NATPERS' AND "anonymized_at" IS NOT NULL;
INSERT INTO "client_tax_registration" ("tenant_id", "client_id", "label", "number_elster", "tax_office_code", "is_primary")
SELECT "tenant_id", "id", 'Bisherige Steuernummer', "steuernummer", left("steuernummer", 4), TRUE
FROM "client" WHERE "steuernummer" IS NOT NULL AND "steuernummer" <> '';

ALTER TABLE "client_tax_registration" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "client_tax_registration" FORCE ROW LEVEL SECURITY;
CREATE POLICY "client_tax_registration_select" ON "client_tax_registration" FOR SELECT USING (
  "tenant_id" = app.current_tenant_id() AND (
    app.current_actor_type() = 'SYSTEM'
    OR (app.current_actor_type() = 'STAFF' AND app.notification_staff_can_access_client("tenant_id", app.current_actor_id(), "client_id"))
    OR (app.current_actor_type() = 'CLIENT_CONTACT' AND EXISTS (
      SELECT 1 FROM "client_contact" c WHERE c.id = app.current_actor_id() AND c.tenant_id = client_tax_registration.tenant_id AND c.client_id = client_tax_registration.client_id AND c.active
    ))
  )
);
CREATE POLICY "client_tax_registration_insert" ON "client_tax_registration" FOR INSERT WITH CHECK (
  "tenant_id" = app.current_tenant_id() AND app.current_actor_type() = 'STAFF'
  AND app.notification_staff_can_access_client("tenant_id", app.current_actor_id(), "client_id")
);
CREATE POLICY "client_tax_registration_update" ON "client_tax_registration" FOR UPDATE USING (
  "tenant_id" = app.current_tenant_id() AND app.current_actor_type() = 'STAFF'
  AND app.notification_staff_can_access_client("tenant_id", app.current_actor_id(), "client_id")
) WITH CHECK (
  "tenant_id" = app.current_tenant_id() AND app.current_actor_type() = 'STAFF'
  AND app.notification_staff_can_access_client("tenant_id", app.current_actor_id(), "client_id")
);
GRANT SELECT, INSERT, UPDATE ON "client_tax_registration" TO taxtronik_app;

ALTER TABLE "elster_kontoabfrage" ADD COLUMN "tax_registration_id" UUID, ADD COLUMN "tax_number_snapshot" TEXT;
ALTER TABLE "elster_kontoabfrage" ADD CONSTRAINT "elster_kontoabfrage_tax_registration_fkey"
  FOREIGN KEY ("tenant_id", "client_id", "tax_registration_id") REFERENCES "client_tax_registration"("tenant_id", "client_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
-- Legacy queries intentionally remain unassigned: today's number is no evidence of the number used then.

ALTER TABLE "gwg_onboarding_invite" ADD COLUMN "cancellation_reason" TEXT;
-- Persist the truthful cutover facts before cancellation. The idempotent app cutover
-- command appends these facts later through EvidenceService, never forged SQL hashes.
INSERT INTO "tenant_setting" ("tenant_id", "key", "value", "updated_at")
SELECT "tenant_id", 'migration.gwg_invite_v2', jsonb_build_object(
  'occurredAt', CURRENT_TIMESTAMP,
  'invites', jsonb_agg(jsonb_build_object('id', "id", 'clientId', "client_id"))
), CURRENT_TIMESTAMP
FROM "gwg_onboarding_invite" WHERE "status" IN ('PENDING', 'STARTED') GROUP BY "tenant_id"
ON CONFLICT ("tenant_id", "key") DO NOTHING;
UPDATE "gwg_onboarding_invite" SET "status" = 'CANCELLED', "cancelled_at" = CURRENT_TIMESTAMP,
  "cancelled_by_staff" = NULL, "token_hash" = '',
  "cancellation_reason" = 'Umstellung steuerlicher Stammdaten: alter Link widerrufen. Bitte bei Bedarf einen neuen Link ausstellen.',
  "updated_at" = CURRENT_TIMESTAMP
WHERE "status" IN ('PENDING', 'STARTED');
COMMIT;
