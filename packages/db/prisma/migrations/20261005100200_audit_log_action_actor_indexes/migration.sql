-- AUDIT-HASH-CHAIN-001 / TCMS-SAMPLE-PROOF-001 / RISK-CATALOG-FOUR-EYES-001 /
-- DSGVO-CONTACT-EXPORT-001.
--
-- Verhaltensneutral; Review-Finding P-11. Fachliche Leser filtern audit_log
-- nach `action` (Los-Ziehungen, Risikokatalog-Definitionen, Kategorien der
-- Audit-Adminseite) bzw. nach Akteur (DSGVO-Auskunft eines Kontakts). Indiziert
-- waren nur Zeit, Ressource und (tenant_id, id): Die Los-Liste las rückwärts
-- über alle jüngeren Tenant-Ereignisse, Katalogprüfung, Kategorie-Zählung und
-- DSGVO-Auskunft lasen die ganze Tabelle.
--
--  * (tenant_id, action, id): Gleichheit auf action, Reihenfolge nach id (Los-
--    Liste `ORDER BY id DESC LIMIT 10`; Kategoriefilter `action IN (...)`).
--  * (tenant_id, actor_id, actor_type): Die Leser laufen unter RLS. Dort darf
--    PostgreSQL nur LEAKPROOF-Vergleiche als Indexbedingung nutzen; der
--    Enum-Vergleich auf actor_type (enum_eq) ist es nicht, der UUID-Vergleich
--    auf actor_id schon. actor_id steht deshalb vor actor_type: Die DSGVO-
--    Auskunft wird ein direkter Bereichszugriff, actor_type prüft der Filter.
--    In der Reihenfolge (tenant_id, actor_type, actor_id) müsste PostgreSQL 16
--    den ganzen Tenant-Bereich des Index lesen.
--
-- Die Hash-Kette und alle Inhalte bleiben unverändert; audit_log ist
-- append-only, die Indizes kosten je Ereignis zwei zusätzliche B-Tree-Einträge.
-- Aufwand beim Deploy: CREATE INDEX sperrt Schreibzugriffe auf audit_log
-- während des Aufbaus (Schreiber sind beim Deploy gestoppt). Gemessen bei
-- 3,3 Mio. Ereignissen auf 2 Kernen: zusammen rund 15 s, Größe 197 MB
-- (action) und 23 MB (Akteur, dedupliziert).
BEGIN;

CREATE INDEX "audit_log_tenant_id_action_id_idx"
  ON "audit_log" ("tenant_id", "action", "id");

CREATE INDEX "audit_log_tenant_id_actor_id_actor_type_idx"
  ON "audit_log" ("tenant_id", "actor_id", "actor_type");

COMMIT;
