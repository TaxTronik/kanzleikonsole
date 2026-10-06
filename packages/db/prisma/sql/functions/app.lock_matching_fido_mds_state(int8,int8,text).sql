CREATE OR REPLACE FUNCTION app.lock_matching_fido_mds_state(expected_serial bigint, expected_policy_revision bigint, expected_policy_hash text)
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT trust_state."blob_serial" = expected_serial
     AND trust_state."blob_serial" > 0
     AND trust_state."policy_revision" = expected_policy_revision
     AND trust_state."policy_hash" = expected_policy_hash
    FROM public."fido_mds_trust_state" AS trust_state
   WHERE trust_state."singleton" = TRUE
   FOR SHARE OF trust_state
$function$;
