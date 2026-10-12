CREATE OR REPLACE FUNCTION app.risk_los_ziehung_projection(p_after jsonb)
 RETURNS TABLE(commitment text, rahmen_typ text, nachweis jsonb, rahmen jsonb, zeitraum jsonb, review_aufgaben jsonb, attempt_id text, job_id text)
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
  -- TCMS-SAMPLE-PROOF-001 (Welle 15, P-11): fachliche Felder einer Los-Ziehung
  -- aus dem after-Payload des Audit-Ereignisses risk.los.gezogen. Kein Ergebnis,
  -- wenn Nachweis, Commitment, Stichprobe oder Rahmen fehlen; solche Ereignisse
  -- zeigte die Los-Liste schon bisher nicht an.
  SELECT p_after #>> '{nachweis,rahmen,commitment}',
         CASE WHEN p_after ->> 'rahmenTyp' = 'audit' THEN 'audit' ELSE 'subsumtion' END,
         p_after -> 'nachweis',
         p_after -> 'rahmen',
         NULLIF(p_after -> 'zeitraum', 'null'::jsonb),
         COALESCE(NULLIF(p_after -> 'reviewAufgaben', 'null'::jsonb), '[]'::jsonb),
         p_after ->> 'attemptId',
         p_after ->> 'jobId'
   WHERE jsonb_typeof(p_after) = 'object'
     AND jsonb_typeof(p_after -> 'nachweis') = 'object'
     AND jsonb_typeof(p_after #> '{nachweis,rahmen,commitment}') = 'string'
     AND jsonb_typeof(p_after #> '{nachweis,stichprobe}') = 'array'
     AND jsonb_typeof(p_after -> 'rahmen') = 'array'
     AND COALESCE(jsonb_typeof(p_after -> 'zeitraum'), 'null') IN ('object', 'null')
     AND COALESCE(jsonb_typeof(p_after -> 'reviewAufgaben'), 'null') IN ('array', 'null')
$function$;
