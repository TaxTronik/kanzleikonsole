-- Fachkatalog: TCMS-SAMPLE-PROOF-001
--
-- Erwarteter Stand von risk_los_ziehung nach allen Migrationen fuer die
-- historischen Audit-Ereignisse aus los-ziehung-fixtures.sql.
SET TIME ZONE 'UTC';
DO $$
DECLARE
  legacy public.risk_los_ziehung;
  nachschau public.risk_los_ziehung;
  source_after jsonb;
BEGIN
  IF (SELECT count(*) FROM risk_los_ziehung WHERE audit_log_id BETWEEN 9150001 AND 9150004) <> 2 THEN
    RAISE EXCEPTION 'expected exactly the two complete draws to be migrated';
  END IF;
  IF EXISTS (SELECT 1 FROM risk_los_ziehung WHERE audit_log_id IN (9150003, 9150004)) THEN
    RAISE EXCEPTION 'incomplete draw or other action was migrated';
  END IF;

  SELECT * INTO legacy FROM risk_los_ziehung WHERE audit_log_id = 9150001;
  SELECT after INTO source_after FROM audit_log WHERE id = 9150001;
  IF legacy.tenant_id <> '10000000-0000-4000-8000-000000001500'
     OR legacy.audit_occurred_at <> '2026-06-10 08:00:00+00'
     OR legacy.commitment <> 'c0ffee'
     OR legacy.rahmen_typ <> 'subsumtion'
     OR legacy.nachweis <> source_after -> 'nachweis'
     OR legacy.rahmen <> source_after -> 'rahmen'
     OR legacy.zeitraum <> source_after -> 'zeitraum'
     OR legacy.review_aufgaben <> '["30000000-0000-4000-8000-000000001500"]'::jsonb
     OR legacy.attempt_id <> '40000000-0000-4000-8000-000000001500'
     OR legacy.job_id IS NOT NULL THEN
    RAISE EXCEPTION 'legacy subsumtion draw was not migrated losslessly: %', row_to_json(legacy);
  END IF;

  SELECT * INTO nachschau FROM risk_los_ziehung WHERE audit_log_id = 9150002;
  SELECT after INTO source_after FROM audit_log WHERE id = 9150002;
  IF nachschau.tenant_id <> '10000000-0000-4000-8000-000000001501'
     OR nachschau.rahmen_typ <> 'audit'
     OR nachschau.nachweis <> source_after -> 'nachweis'
     OR nachschau.rahmen <> '["17","18"]'::jsonb
     OR nachschau.review_aufgaben <> '[]'::jsonb
     OR nachschau.attempt_id IS NOT NULL
     OR nachschau.job_id <> 'ibm-job-15' THEN
    RAISE EXCEPTION 'audit draw was not migrated losslessly: %', row_to_json(nachschau);
  END IF;
END $$;

-- Die Zeilen sind nach der Migration unveraenderlich.
DO $$
BEGIN
  BEGIN
    UPDATE risk_los_ziehung SET commitment = 'x' WHERE audit_log_id = 9150001;
    RAISE EXCEPTION 'risk_los_ziehung accepted an UPDATE';
  EXCEPTION WHEN restrict_violation THEN
    NULL;
  END;
END $$;
