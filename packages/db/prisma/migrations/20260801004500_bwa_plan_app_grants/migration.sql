-- =============================================================================
-- BWA-Planung: explizite Berechtigungen fuer die eingeschraenkte App-Rolle
--
-- iter26 hat `bwa_plan` und `bwa_plan_line` angelegt, aber im Gegensatz zu den
-- benachbarten Feature-Migrationen keinen expliziten Grant gesetzt. Dadurch
-- hing der Zugriff davon ab, ob die Default-Privileges fuer exakt den
-- Migrations-Owner provisioniert waren. Das ist weder bei allen bestehenden
-- Installationen noch bei isolierten Restore-/Migrationspruefungen garantiert.
--
-- GRANT ist idempotent und repariert Bestandsinstallationen ebenso wie eine
-- frische, vollstaendig ausgerollte Datenbank. RLS bleibt fuer beide Tabellen
-- unveraendert aktiv; der Grant eroeffnet nur den Zugriff, die Policies grenzen
-- ihn weiterhin auf den aktuellen Tenant ein.
-- =============================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "bwa_plan" TO taxtronik_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "bwa_plan_line" TO taxtronik_app;
