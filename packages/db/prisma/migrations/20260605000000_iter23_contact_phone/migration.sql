-- =============================================================================
-- Iter. 23: Telefon + Rolle an Ansprechpartnern
--
-- ClientContact hatte bisher nur Mail + Name. Für ein nützliches
-- „Personenbuch" am Mandanten kommen Telefon und Rolle (z. B.
-- „Geschäftsführer", „Buchhaltung") hinzu — optional, ohne
-- Schema-Pflicht. Portal-Zugang bleibt unverändert (E-Mail-basiert).
-- =============================================================================

ALTER TABLE "client_contact"
  ADD COLUMN "phone" TEXT,
  ADD COLUMN "role"  TEXT;
