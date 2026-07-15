-- Mehrfachprofile: Login-/Profilwechsel suchen Kontakte tenantweit per E-Mail.
-- CONCURRENTLY haelt bestehende Portal-Schreibzugriffe waehrend des Updates offen.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "client_contact_tenant_email_idx"
  ON "client_contact"("tenant_id", "email");

-- Ein kontaktgebundener Link darf nach Loeschung des Kontakts nicht durch den
-- Legacy-/Profilauswahl-Fallback auf einen anderen Kontakt derselben Adresse
-- umgebogen werden. E-Mail-gebundene Auswahl-Links haben contact_id bereits
-- bei der Anlage NULL und bleiben davon unberuehrt.
BEGIN;

ALTER TABLE "magic_link"
  DROP CONSTRAINT IF EXISTS "magic_link_contact_id_fkey";

ALTER TABLE "magic_link"
  ADD CONSTRAINT "magic_link_contact_id_fkey"
  FOREIGN KEY ("contact_id")
  REFERENCES "client_contact"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

COMMIT;
