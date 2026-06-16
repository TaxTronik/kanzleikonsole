-- Ansprechpartner-E-Mails sind nur pro Mandantendatensatz eindeutig.
-- Dieselbe Person kann fachlich mehrere Mandanten/Unternehmen vertreten.
DROP INDEX IF EXISTS "client_contact_tenant_id_email_key";

CREATE UNIQUE INDEX IF NOT EXISTS "client_contact_tenant_id_client_id_email_key"
  ON "client_contact"("tenant_id", "client_id", "email");

-- Magic-Links werden ab jetzt eindeutig an den Kontakt gebunden. Alte Links
-- ohne contact_id bleiben verifizierbar ueber den bisherigen tenant/email-Fallback.
ALTER TABLE "magic_link" ADD COLUMN IF NOT EXISTS "contact_id" UUID;

CREATE INDEX IF NOT EXISTS "magic_link_contact_id_idx"
  ON "magic_link"("contact_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'magic_link_contact_id_fkey'
       AND conrelid = 'magic_link'::regclass
  ) THEN
    ALTER TABLE "magic_link"
      ADD CONSTRAINT "magic_link_contact_id_fkey"
      FOREIGN KEY ("contact_id")
      REFERENCES "client_contact"("id")
      ON DELETE SET NULL
      ON UPDATE CASCADE;
  END IF;
END $$;
