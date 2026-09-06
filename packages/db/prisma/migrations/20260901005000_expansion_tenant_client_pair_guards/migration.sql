-- Fachkatalog: ACCESS-TENANT-RLS-001
--
-- Zwölf Ausbauaggregate wurden nach der zentralen Paar-Guard-Migration
-- angelegt. Einzelne FKs auf tenant_id und client_id verhindern kein
-- Cross-Tenant-Paar, wenn beide Eltern jeweils fuer sich existieren. Diese
-- additive Migration inventarisiert den Altbestand und installiert denselben
-- zentralen, race-sicheren Guard wie fuer die Bestandsaggregate.

DO $audit_expansion_tenant_client_pairs$
DECLARE
  pair_table TEXT;
  mismatch_count BIGINT;
  mismatch_details TEXT[] := ARRAY[]::TEXT[];
BEGIN
  FOREACH pair_table IN ARRAY ARRAY[
    'client_assistance_case',
    'client_interaction',
    'gwg_structure_binding',
    'mandate_artifact',
    'mandate_offboarding',
    'mandate_structure_version',
    'payroll_intake',
    'screening_review',
    'screening_run',
    'stbvv_quote',
    'vdb_record',
    'year_end_campaign_entry'
  ]::TEXT[]
  LOOP
    IF to_regclass(format('public.%I', pair_table)) IS NULL THEN
      RAISE EXCEPTION 'Erwartete Tenant-/Mandanten-Paartabelle fehlt: %', pair_table
        USING ERRCODE = 'undefined_table';
    END IF;

    EXECUTE format(
      'SELECT COUNT(*)
         FROM public.%I child
         LEFT JOIN public.client parent ON parent.id = child.client_id
        WHERE child.client_id IS NOT NULL
          AND (parent.id IS NULL OR parent.tenant_id IS DISTINCT FROM child.tenant_id)',
      pair_table
    ) INTO mismatch_count;

    IF mismatch_count > 0 THEN
      mismatch_details := array_append(
        mismatch_details,
        format('%I=%s', pair_table, mismatch_count)
      );
    END IF;
  END LOOP;

  IF cardinality(mismatch_details) > 0 THEN
    RAISE EXCEPTION 'Tenant-/Mandanten-Paarpruefung der Ausbauaggregate fehlgeschlagen.'
      USING ERRCODE = 'check_violation',
            DETAIL = array_to_string(mismatch_details, ', '),
            HINT = 'Betroffene Zeilen fachlich pruefen und kontrolliert bereinigen; Migration danach erneut ausfuehren.';
  END IF;
END;
$audit_expansion_tenant_client_pairs$;

DO $install_expansion_tenant_client_pair_guards$
DECLARE
  pair_table TEXT;
BEGIN
  IF to_regprocedure('app.enforce_tenant_client_pair_integrity()') IS NULL THEN
    RAISE EXCEPTION 'Zentrale Funktion app.enforce_tenant_client_pair_integrity() fehlt.'
      USING ERRCODE = 'undefined_function';
  END IF;

  FOREACH pair_table IN ARRAY ARRAY[
    'client_assistance_case',
    'client_interaction',
    'gwg_structure_binding',
    'mandate_artifact',
    'mandate_offboarding',
    'mandate_structure_version',
    'payroll_intake',
    'screening_review',
    'screening_run',
    'stbvv_quote',
    'vdb_record',
    'year_end_campaign_entry'
  ]::TEXT[]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER "00_tenant_client_pair_integrity"
         BEFORE INSERT OR UPDATE OF tenant_id, client_id ON public.%I
         FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant_client_pair_integrity()',
      pair_table
    );
  END LOOP;
END;
$install_expansion_tenant_client_pair_guards$;
