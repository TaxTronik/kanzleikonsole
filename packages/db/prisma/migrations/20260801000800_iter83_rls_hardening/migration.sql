-- =============================================================================
-- iter83 — RLS-Härtung: bwa_plan_line-Policy, audit_archive-REVOKE,
-- search_path-Pinning für Trigger-Funktionen, Anonymisierungs-Backfill.
--
-- Teil 1 (HOCH): bwa_plan_line hatte seit iter26 KEIN RLS — weder ENABLE noch
--   FORCE noch eine Policy. iter26 hat nur bwa_plan abgesichert; der
--   FORCE-Sweep in iter42 und der Backfill in iter78 setzten beide nur an
--   bereits ENABLEd-Tabellen an und haben die Zeilen-Tabelle übersehen. Da die
--   App-Rolle via ALTER DEFAULT PRIVILEGES (infra/scripts/postgres-init.sh)
--   Vollzugriff auf alle neuen Tabellen bekommt, waren die Planzeilen ALLER
--   Tenants für jede App-Session les- und schreibbar — einziger Schutz war der
--   App-seitige Tenant-Filter. Fix: Join-Policy nach dem bwa_position-Muster
--   (iter6) — bwa_plan_line trägt kein eigenes tenant_id, die Tenant-Zuordnung
--   läuft über EXISTS auf den Eltern-Plan. ENABLE + FORCE analog iter42/78
--   (FORCE: RLS gilt sonst nicht für den Tabellen-Owner; der Owner taxtronik
--   hat BYPASSRLS, Migrationen/Seeds laufen also weiter).
--   Vollmatrix-Check (CREATE TABLE vs. ENABLE ROW LEVEL SECURITY über ALLE
--   Migrationen): einzige weitere Tabelle ohne RLS ist tax_news_item (iter28)
--   — dort bewusst, die Tabelle ist global (öffentliche BMF/BFH-RSS-Quellen,
--   kein tenant_id, ein Datensatz wird von allen Tenants geteilt). Kein
--   Handlungsbedarf.
--
-- Teil 2 (NIEDRIG): audit_archive vervollständigt das Doppelschicht-Muster der
--   Audit-Tabellen. audit_log/audit_seal haben seit init BEIDES: Block-Trigger
--   UND REVOKE UPDATE/DELETE/TRUNCATE für die App-Rolle (Defense in Depth —
--   ein versehentlich gedroppter Trigger ließe sonst die Mutation durch).
--   audit_archive (iter18/iter50) hatte nur die Trigger-Schicht.
--
-- Teil 3 (NIEDRIG): search_path-Pinning für alle Funktionen aus Migrationen,
--   die iter48 nicht erfasst hat. iter48 pinnte nur die drei RLS-Helper
--   (SECURITY DEFINER). Die übrigen Trigger-Funktionen laufen zwar als Invoker
--   (kein SECURITY DEFINER), treffen aber Sicherheitsentscheidungen über
--   UNQUALIFIZIERTE Verweise auf "client"/"gwg_check"/"workflow_item" — ein
--   manipulierter Session-search_path könnte z. B. die GwG-Schranke über eine
--   geschattete "client"-Relation aushebeln. Gepinnt wird auf
--   `pg_catalog, public` (nicht nur `pg_catalog` wie in iter48), weil diese
--   Funktionen Public-Schema-Tabellen referenzieren.
--
-- Teil 4 (Daten-Backfill, DSGVO Art. 17): Die Kontakt-Anonymisierung
--   (apps/web/src/server/dsgvo/anonymize-contact.ts) überschrieb bisher nur
--   email/full_name und deaktivierte das Konto — phone und role (iter23/...)
--   blieben stehen. Der Code-Fix NULLt beide Felder künftig mit; hier der
--   Backfill für bereits anonymisierte Bestandskontakte (erkennbar am
--   Anonymisierungs-Schema `anonymized-<uuid>@taxtronik.local`, vgl.
--   isAnonymizedContactEmail). Läuft als Owner mit BYPASSRLS über alle
--   Tenants — gewollt, der Backfill ist tenant-übergreifend.
-- =============================================================================

-- ----- Teil 1: bwa_plan_line — RLS via Join-Policy auf bwa_plan --------------

ALTER TABLE "bwa_plan_line" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bwa_plan_line" FORCE ROW LEVEL SECURITY;

CREATE POLICY bwa_plan_line_isolation ON "bwa_plan_line"
    USING (EXISTS (
        SELECT 1 FROM "bwa_plan" p
        WHERE p.id = "bwa_plan_line"."plan_id"
          AND p.tenant_id = app.current_tenant_id()
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM "bwa_plan" p
        WHERE p.id = "bwa_plan_line"."plan_id"
          AND p.tenant_id = app.current_tenant_id()
    ));

-- ----- Teil 2: audit_archive — REVOKE analog audit_log/audit_seal (init) -----

REVOKE UPDATE, DELETE, TRUNCATE ON "audit_archive" FROM taxtronik_app;

-- ----- Teil 3: search_path-Pinning (alle Funktionen ohne SET search_path) ----
-- Bestandsaufnahme per Grep über alle Migrationen: CREATE [OR REPLACE] FUNCTION
-- ohne `SET search_path` — app.current_tenant_id/current_actor_id/
-- current_actor_type sind seit iter48 gepinnt, alle folgenden noch nicht.

-- init: Audit-Append-Only, Immutable-Dokumentversionen, GwG-Schranke Dokument
ALTER FUNCTION app.prevent_modification() SET search_path = pg_catalog, public;
ALTER FUNCTION app.protect_immutable_document_version() SET search_path = pg_catalog, public;
ALTER FUNCTION app.enforce_client_active_for_document() SET search_path = pg_catalog, public;
-- iter2: GwG-Schranke Anforderung
ALTER FUNCTION app.enforce_client_active_for_request() SET search_path = pg_catalog, public;
-- iter4: allow_active nur mit verifiziertem gwg_check
ALTER FUNCTION app.enforce_client_allow_active_requires_gwg() SET search_path = pg_catalog, public;
-- iter5: GwG-Schranke Rechnung
ALTER FUNCTION app.enforce_client_active_for_invoice() SET search_path = pg_catalog, public;
-- iter10: Einspruchsfrist-Default
ALTER FUNCTION app.tax_notice_set_appeal_deadline() SET search_path = pg_catalog, public;
-- iter18/iter50: audit_archive insert-only
ALTER FUNCTION app.audit_archive_block_mutation() SET search_path = pg_catalog, public;
ALTER FUNCTION app.audit_archive_block_truncate() SET search_path = pg_catalog, public;
-- iter30: Workflow-Auto-Resolution (Public-Schema, ohne app.-Präfix angelegt)
ALTER FUNCTION public.trg_request_closed_complete_workflow_item() SET search_path = pg_catalog, public;
ALTER FUNCTION public.trg_submission_submitted_complete_workflow_item() SET search_path = pg_catalog, public;

-- ----- Teil 4: Backfill — phone/role bereits anonymisierter Kontakte ---------

UPDATE "client_contact"
   SET "phone" = NULL,
       "role"  = NULL
 WHERE "email" LIKE 'anonymized-%@taxtronik.local'
   AND ("phone" IS NOT NULL OR "role" IS NOT NULL);
