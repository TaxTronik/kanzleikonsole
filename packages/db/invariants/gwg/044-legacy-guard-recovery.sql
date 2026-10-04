-- =============================================================================
-- Unveraenderliche zugeordnete GwG-Beweisversionen ab
-- 20260801004400_legacy_gwg_guard_recovery
-- =============================================================================
-- Vertrag wie in 034-fail-closed-and-destruction.sql: genau ein lesendes
-- Statement, Spalte "invariant", eine Zeile je verletzter Invariante mit
-- stabilem Namen, keine Zeile = erfuellt. Pflicht fuer den Writer-Start, sobald
-- der Checkout 04400 enthaelt.
--
-- Die Triggerfunktion wurde seit 03400 mehrfach neu definiert (04400, die
-- Ledger-Reparaturen 20260809000000/20260809000100 und das Onboarding-Verwerfen
-- 20260819000000). Jede Neufassung muss diese Schutzbausteine behalten: Sperre
-- des Dokuments (FOR UPDATE), Unveraenderlichkeit zugeordneter Ausweisbelege
-- (public."gwg_id_document") und Loeschen nur ueber den autorisierten
-- Vernichtungspfad (app.gwg_destroy_document_id -> authorized_delete).
--
-- Fachkatalog: GWG-IDENTIFICATION-EVIDENCE-001, GWG-RETENTION-DESTRUCTION-001,
-- GWG-SELF-ONBOARDING-001
-- =============================================================================
WITH expected_body_part (part, needle) AS (
  VALUES
    ('assigned_evidence_guard', 'public."gwg_id_document"'),
    ('destruction_authorization', 'app.gwg_destroy_document_id'),
    ('authorized_delete', 'authorized_delete'),
    ('document_row_lock', 'FOR UPDATE')
),
guard_function AS (
  SELECT p.prosrc
    FROM pg_catalog.pg_proc p
   WHERE p.oid = pg_catalog.to_regprocedure('app.block_version_during_gwg_destruction()')
),
violation (invariant) AS (
  SELECT 'gwg_044.function:app.block_version_during_gwg_destruction()'
   WHERE NOT EXISTS (SELECT 1 FROM guard_function)

  UNION ALL
  SELECT 'gwg_044.function_body:app.block_version_during_gwg_destruction().' || e.part
    FROM expected_body_part e
    CROSS JOIN guard_function g
   WHERE NOT COALESCE(pg_catalog.strpos(g.prosrc, e.needle) > 0, FALSE)

  UNION ALL
  SELECT 'gwg_044.trigger:document_version.document_version_block_gwg_destruction'
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_catalog.pg_trigger t
      WHERE t.tgname = 'document_version_block_gwg_destruction'
        AND t.tgrelid = pg_catalog.to_regclass('public.document_version')
        AND t.tgfoid = pg_catalog.to_regprocedure('app.block_version_during_gwg_destruction()')
        AND NOT t.tgisinternal
        AND t.tgenabled IN ('O', 'A')
   )
)
SELECT invariant
  FROM violation
 ORDER BY invariant;
