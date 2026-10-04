-- =============================================================================
-- GwG-Identitaetszuordnung ab 20260801004300_gwg_identity_subjects_and_document_sets
-- =============================================================================
-- Vertrag wie in 034-fail-closed-and-destruction.sql: genau ein lesendes
-- Statement, Spalte "invariant", eine Zeile je verletzter Invariante mit
-- stabilem Namen, keine Zeile = erfuellt. Pflicht fuer den Writer-Start, sobald
-- der Checkout 04300 oder 20260801004400_legacy_gwg_guard_recovery enthaelt.
--
-- Fachkatalog: GWG-ACTIVATION-GATE-001, GWG-IDENTIFICATION-EVIDENCE-001,
-- GWG-RETENTION-DESTRUCTION-001
-- =============================================================================
WITH expected_column (table_name, column_name, udt_name, must_be_not_null) AS (
  VALUES
    ('gwg_check', 'identity_assignment_required', 'bool', TRUE),
    ('gwg_id_document', 'document_set_id', 'uuid', TRUE),
    ('gwg_id_document', 'natural_client_subject_id', 'uuid', FALSE),
    ('gwg_id_document', 'beneficial_owner_subject_id', 'uuid', FALSE),
    ('gwg_id_document', 'representative_subject_id', 'uuid', FALSE),
    ('gwg_id_document', 'identity_assignment_confirmed_at', 'timestamptz', FALSE),
    ('gwg_id_document', 'identity_assignment_confirmed_by', 'uuid', FALSE),
    ('gwg_representative', 'id', 'uuid', TRUE),
    ('gwg_representative', 'gwg_check_id', 'uuid', TRUE),
    ('gwg_representative', 'full_name', 'text', TRUE),
    ('gwg_representative', 'position', 'int4', TRUE),
    ('gwg_representative', 'created_at', 'timestamptz', TRUE),
    ('gwg_representative', 'updated_at', 'timestamptz', TRUE)
),
expected_constraint (table_name, constraint_name, constraint_type) AS (
  VALUES
    ('gwg_check', 'gwg_check_identity_assignment_required_state', 'c'),
    ('gwg_representative', 'gwg_representative_pkey', 'p'),
    ('gwg_representative', 'gwg_representative_name_not_blank', 'c'),
    ('gwg_representative', 'gwg_representative_position_nonnegative', 'c'),
    ('gwg_representative', 'gwg_representative_gwg_check_id_position_key', 'u'),
    ('gwg_representative', 'gwg_representative_gwg_check_id_fkey', 'f'),
    ('gwg_id_document', 'gwg_id_document_gwg_check_id_document_id_key', 'u'),
    ('gwg_id_document', 'gwg_id_document_natural_client_subject_id_fkey', 'f'),
    ('gwg_id_document', 'gwg_id_document_beneficial_owner_subject_id_fkey', 'f'),
    ('gwg_id_document', 'gwg_id_document_representative_subject_id_fkey', 'f'),
    ('gwg_id_document', 'gwg_id_document_identity_subject_count', 'c'),
    ('gwg_id_document', 'gwg_id_document_identity_subject_personal_type', 'c'),
    ('gwg_id_document', 'gwg_id_document_identity_confirmation_complete', 'c')
),
expected_index (index_name) AS (
  VALUES
    ('gwg_representative_gwg_check_id_idx'),
    ('gwg_id_document_gwg_check_id_document_set_id_idx'),
    ('gwg_id_document_natural_client_subject_id_idx'),
    ('gwg_id_document_beneficial_owner_subject_id_idx'),
    ('gwg_id_document_representative_subject_id_idx')
),
expected_function (signature) AS (
  VALUES
    ('app.guard_gwg_id_document_subject_and_set()'),
    ('app.enforce_gwg_document_set_consistency()'),
    ('app.protect_verified_gwg_representative()'),
    ('app.purge_gwg_representatives_after_destruction()'),
    ('app.invalidate_gwg_beneficial_owner_identity_assignment()'),
    ('app.gwg_check_has_confirmed_identity(uuid)'),
    ('app.enforce_gwg_identity_assignment_on_verification()')
),
expected_trigger (table_name, trigger_name, function_signature) AS (
  VALUES
    ('gwg_id_document', 'gwg_id_document_subject_and_set_guard', 'app.guard_gwg_id_document_subject_and_set()'),
    ('gwg_id_document', 'gwg_document_set_consistency', 'app.enforce_gwg_document_set_consistency()'),
    ('gwg_representative', 'gwg_representative_verified_snapshot_immutable', 'app.protect_verified_gwg_representative()'),
    ('gwg_check', 'gwg_check_purge_representatives_after_destruction', 'app.purge_gwg_representatives_after_destruction()'),
    ('gwg_beneficial_owner', 'gwg_beneficial_owner_identity_assignment_invalidate', 'app.invalidate_gwg_beneficial_owner_identity_assignment()'),
    ('gwg_check', '00_gwg_check_identity_verification_guard', 'app.enforce_gwg_identity_assignment_on_verification()')
),
violation (invariant) AS (
  SELECT 'gwg_043.table:gwg_representative'
   WHERE pg_catalog.to_regclass('public.gwg_representative') IS NULL

  UNION ALL
  SELECT 'gwg_043.column:' || e.table_name || '.' || e.column_name
    FROM expected_column e
    LEFT JOIN information_schema.columns c
      ON c.table_schema = 'public'
     AND c.table_name = e.table_name
     AND c.column_name = e.column_name
     AND c.udt_name = e.udt_name
   WHERE c.column_name IS NULL
      OR (e.must_be_not_null AND c.is_nullable <> 'NO')

  -- Nur validierte Constraints zaehlen; NOT VALID schuetzt Altbestand nicht.
  UNION ALL
  SELECT 'gwg_043.constraint:' || e.table_name || '.' || e.constraint_name
    FROM expected_constraint e
    LEFT JOIN pg_catalog.pg_constraint con
      ON con.conname = e.constraint_name
     AND con.contype = e.constraint_type::"char"
     AND con.conrelid = pg_catalog.to_regclass('public.' || e.table_name)
     AND con.convalidated
   WHERE con.oid IS NULL

  UNION ALL
  SELECT 'gwg_043.index:' || e.index_name
    FROM expected_index e
   WHERE pg_catalog.to_regclass('public.' || e.index_name) IS NULL

  UNION ALL
  SELECT 'gwg_043.forced_rls:gwg_representative'
   WHERE NOT COALESCE((
     SELECT c.relrowsecurity AND c.relforcerowsecurity
       FROM pg_catalog.pg_class c
      WHERE c.oid = pg_catalog.to_regclass('public.gwg_representative')
   ), FALSE)

  UNION ALL
  SELECT 'gwg_043.policy:gwg_representative.gwg_representative_isolation'
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_catalog.pg_policy policy
      WHERE policy.polname = 'gwg_representative_isolation'
        AND policy.polrelid = pg_catalog.to_regclass('public.gwg_representative')
   )

  UNION ALL
  SELECT 'gwg_043.function:' || e.signature
    FROM expected_function e
    LEFT JOIN pg_catalog.pg_proc p
      ON p.oid = pg_catalog.to_regprocedure(e.signature)
   WHERE p.oid IS NULL

  UNION ALL
  SELECT 'gwg_043.trigger:' || e.table_name || '.' || e.trigger_name
    FROM expected_trigger e
    LEFT JOIN pg_catalog.pg_trigger t
      ON t.tgname = e.trigger_name
     AND t.tgrelid = pg_catalog.to_regclass('public.' || e.table_name)
     AND t.tgfoid = pg_catalog.to_regprocedure(e.function_signature)
     AND NOT t.tgisinternal
     AND t.tgenabled IN ('O', 'A')
   WHERE t.oid IS NULL

  -- Die Dokumentsatz-Konsistenz greift erst am Transaktionsende.
  UNION ALL
  SELECT 'gwg_043.deferred_constraint_trigger:gwg_id_document.gwg_document_set_consistency'
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_catalog.pg_trigger t
      WHERE t.tgname = 'gwg_document_set_consistency'
        AND t.tgrelid = pg_catalog.to_regclass('public.gwg_id_document')
        AND t.tgfoid = pg_catalog.to_regprocedure('app.enforce_gwg_document_set_consistency()')
        AND NOT t.tgisinternal
        AND t.tgenabled IN ('O', 'A')
        AND t.tgconstraint <> 0
        AND t.tgdeferrable
        AND t.tginitdeferred
   )

  UNION ALL
  SELECT 'gwg_043.app_execute:app.gwg_check_has_confirmed_identity(uuid)'
   WHERE NOT COALESCE((
     SELECT pg_catalog.has_function_privilege(
              r.oid,
              pg_catalog.to_regprocedure('app.gwg_check_has_confirmed_identity(uuid)'),
              'EXECUTE'
            )
       FROM pg_catalog.pg_roles r
      WHERE r.rolname = 'taxtronik_app'
   ), FALSE)

  UNION ALL
  SELECT 'gwg_043.public_execute:app.gwg_check_has_confirmed_identity(uuid)'
   WHERE EXISTS (
     SELECT 1
       FROM pg_catalog.pg_proc p
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
       ) acl
      WHERE p.oid = pg_catalog.to_regprocedure('app.gwg_check_has_confirmed_identity(uuid)')
        AND acl.grantee = 0
        AND acl.privilege_type = 'EXECUTE'
   )
)
SELECT invariant
  FROM violation
 ORDER BY invariant;
