-- =============================================================================
-- iter70: Mandant-Vertraulich-Flag (Zugriffs-Ventil für das OPEN-Zugriffsmodell).
--
-- Default-Zugriffsmodell ist ab jetzt OPEN: jeder aktive Mitarbeiter darf an
-- jedem Mandanten des Tenants arbeiten (Audit-Chain trägt die Accountability).
-- Ein als `vertraulich` markierter Mandant bleibt — auch im OPEN-Modus — auf
-- Admin/Partner + die zugeordneten Berufsträger/Hauptbearbeiter beschränkt
-- (Konflikt-/Geheimhaltungsfälle, z. B. Mandant ist Angehöriger/Konkurrent eines
-- Mitarbeiters). NOT NULL DEFAULT false → bestehende Mandanten bleiben offen.
-- Die RLS-Policy der client-Tabelle deckt die neue Spalte unverändert ab.
-- =============================================================================

ALTER TABLE "client" ADD COLUMN "vertraulich" BOOLEAN NOT NULL DEFAULT false;
