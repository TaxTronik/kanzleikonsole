-- =============================================================================
-- GwG-Schutzschema ab 20260801003400_gwg_fail_closed_and_destruction
-- =============================================================================
-- Vertrag fuer alle Dateien unter packages/db/invariants/:
--   * genau EIN lesendes Statement mit der Ergebnisspalte "invariant";
--   * eine Zeile je verletzter Invariante mit stabilem Namen
--     "<pruefung>.<art>:<objekt>"; keine Zeile = alle Invarianten erfuellt;
--   * die Namen sind Teil des Betriebsvertrags (Deploy-Log, Tests). Nur
--     aendern, wenn sich die geschuetzte Invariante selbst aendert.
-- scripts/ops-lib.sh fuehrt diese Datei nach jeder Kundenmigration unveraendert
-- per psql im Postgres-Container aus (read-only); solange eine Zeile kommt,
-- starten keine schreibenden Dienste. Pflicht, sobald der Checkout 03400 oder
-- 20260801004400_legacy_gwg_guard_recovery enthaelt. CI fuehrt dieselbe Datei
-- mit packages/db/scripts/check-db-invariants.mjs gegen die echte DB aus.
--
-- Fachkatalog: GWG-ACTIVATION-GATE-001, GWG-RETENTION-DESTRUCTION-001,
-- GWG-SELF-ONBOARDING-001
-- =============================================================================
WITH expected_column (table_name, column_name, udt_name, must_be_not_null) AS (
  VALUES
    ('gwg_check', 'legal_form', 'text', FALSE),
    ('gwg_check', 'register_number', 'text', FALSE),
    ('gwg_check', 'register_authority', 'text', FALSE),
    ('gwg_check', 'no_register_entry', 'bool', TRUE),
    ('gwg_check', 'representative_names', '_text', TRUE),
    ('gwg_check', 'ownership_structure_notes', 'text', FALSE),
    ('document', 'gwg_onboarding_invite_id', 'uuid', FALSE),
    ('document', 'gwg_destruction_requested_at', 'timestamptz', FALSE),
    ('document', 'gwg_destruction_requested_by', 'uuid', FALSE),
    ('document', 'gwg_destruction_error', 'text', FALSE),
    ('document', 'gwg_destroyed_at', 'timestamptz', FALSE)
),
expected_foreign_key (table_name, constraint_name) AS (
  VALUES
    ('document', 'document_gwg_invite_fk'),
    ('gwg_onboarding_invite', 'gwg_invite_check_fkey')
),
expected_function (signature, must_be_security_definer) AS (
  VALUES
    ('app.guard_gwg_document_invite_and_claim()', FALSE),
    ('app.guard_gwg_id_document_scope_and_claim()', FALSE),
    ('app.guard_gwg_invite_check_scope_and_claim()', FALSE),
    ('app.freeze_gwg_claim_references()', FALSE),
    ('app.enforce_client_active_for_document()', FALSE),
    ('app.enforce_client_allow_active_requires_gwg()', FALSE),
    ('app.protect_verified_gwg_legal_snapshot()', FALSE),
    ('app.protect_verified_gwg_beneficial_owner()', FALSE),
    ('app.guard_gwg_check_hard_delete()', FALSE),
    ('app.gwg_deactivate_client_without_valid_check()', FALSE),
    ('app.destroy_gwg_check(uuid)', TRUE),
    ('app.protect_immutable_document_version()', FALSE),
    ('app.assert_gwg_document_destruction_due(uuid)', TRUE),
    ('app.destroy_gwg_document_versions(uuid)', TRUE),
    ('app.block_version_during_gwg_destruction()', FALSE)
),
expected_trigger (table_name, trigger_name, function_signature) AS (
  VALUES
    ('document', 'document_gwg_invite_scope_and_claim', 'app.guard_gwg_document_invite_and_claim()'),
    ('gwg_id_document', 'gwg_id_document_scope_and_claim', 'app.guard_gwg_id_document_scope_and_claim()'),
    ('gwg_onboarding_invite', 'gwg_invite_check_scope_and_claim', 'app.guard_gwg_invite_check_scope_and_claim()'),
    ('client', 'client_freeze_gwg_claim', 'app.freeze_gwg_claim_references()'),
    ('gwg_check', 'gwg_check_freeze_gwg_claim', 'app.freeze_gwg_claim_references()'),
    ('gwg_check', 'gwg_check_verified_legal_snapshot_immutable', 'app.protect_verified_gwg_legal_snapshot()'),
    ('gwg_beneficial_owner', 'gwg_beneficial_owner_verified_snapshot_immutable', 'app.protect_verified_gwg_beneficial_owner()'),
    ('gwg_check', 'gwg_check_no_hard_delete', 'app.guard_gwg_check_hard_delete()'),
    ('gwg_check', 'gwg_check_fail_closed_client', 'app.gwg_deactivate_client_without_valid_check()'),
    ('document_version', 'document_version_block_gwg_destruction', 'app.block_version_during_gwg_destruction()')
),
destruction_function (signature) AS (
  VALUES
    ('app.destroy_gwg_check(uuid)'),
    ('app.assert_gwg_document_destruction_due(uuid)'),
    ('app.destroy_gwg_document_versions(uuid)')
),
violation (invariant) AS (
  SELECT 'gwg_034.column:' || e.table_name || '.' || e.column_name
    FROM expected_column e
    LEFT JOIN information_schema.columns c
      ON c.table_schema = 'public'
     AND c.table_name = e.table_name
     AND c.column_name = e.column_name
     AND c.udt_name = e.udt_name
   WHERE c.column_name IS NULL
      OR (e.must_be_not_null AND c.is_nullable <> 'NO')

  UNION ALL
  SELECT 'gwg_034.index:document_gwg_invite_idx'
   WHERE pg_catalog.to_regclass('public.document_gwg_invite_idx') IS NULL

  UNION ALL
  SELECT 'gwg_034.foreign_key:' || e.table_name || '.' || e.constraint_name
    FROM expected_foreign_key e
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_catalog.pg_constraint con
      WHERE con.conname = e.constraint_name
        AND con.contype = 'f'
        AND con.conrelid = pg_catalog.to_regclass('public.' || e.table_name)
   )

  -- Fehlende Funktion oder fehlendes SECURITY DEFINER der Vernichtungspfade.
  UNION ALL
  SELECT 'gwg_034.function:' || e.signature
    FROM expected_function e
    LEFT JOIN pg_catalog.pg_proc p
      ON p.oid = pg_catalog.to_regprocedure(e.signature)
   WHERE p.oid IS NULL
      OR (e.must_be_security_definer AND NOT p.prosecdef)

  -- Trigger muss existieren, auf die erwartete Funktion zeigen und aktiv sein.
  UNION ALL
  SELECT 'gwg_034.trigger:' || e.table_name || '.' || e.trigger_name
    FROM expected_trigger e
    LEFT JOIN pg_catalog.pg_trigger t
      ON t.tgname = e.trigger_name
     AND t.tgrelid = pg_catalog.to_regclass('public.' || e.table_name)
     AND t.tgfoid = pg_catalog.to_regprocedure(e.function_signature)
     AND NOT t.tgisinternal
     AND t.tgenabled IN ('O', 'A')
   WHERE t.oid IS NULL

  -- Die App-Rolle vernichtet ausschliesslich ueber diese Funktionen ...
  UNION ALL
  SELECT 'gwg_034.app_execute:' || f.signature
    FROM destruction_function f
   WHERE NOT COALESCE((
     SELECT pg_catalog.has_function_privilege(r.oid, p.oid, 'EXECUTE')
       FROM pg_catalog.pg_roles r
       JOIN pg_catalog.pg_proc p
         ON p.oid = pg_catalog.to_regprocedure(f.signature)
      WHERE r.rolname = 'taxtronik_app'
   ), FALSE)

  -- ... die PUBLIC nicht ausfuehren darf ...
  UNION ALL
  SELECT 'gwg_034.public_execute:' || f.signature
    FROM destruction_function f
    JOIN pg_catalog.pg_proc p
      ON p.oid = pg_catalog.to_regprocedure(f.signature)
   WHERE EXISTS (
     SELECT 1
       FROM pg_catalog.aclexplode(
              COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
            ) acl
      WHERE acl.grantee = 0
        AND acl.privilege_type = 'EXECUTE'
   )

  -- ... und loescht Dokumentversionen nie direkt.
  UNION ALL
  SELECT 'gwg_034.app_no_delete:document_version'
   WHERE NOT COALESCE((
     SELECT NOT pg_catalog.has_table_privilege(r.oid, c.oid, 'DELETE')
       FROM pg_catalog.pg_roles r
       CROSS JOIN pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE r.rolname = 'taxtronik_app'
        AND n.nspname = 'public'
        AND c.relname = 'document_version'
   ), FALSE)
)
SELECT invariant
  FROM violation
 ORDER BY invariant;
