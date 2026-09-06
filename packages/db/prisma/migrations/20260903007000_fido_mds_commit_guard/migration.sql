-- Fachkatalog: ACCESS-TENANT-RLS-001
-- Bindet jede sicherheitsrelevante WebAuthn-Mutation atomar an genau den
-- FIDO-MDS-Stand, gegen den das Credential unmittelbar zuvor geprüft wurde.
-- Die App-Rolle erhält keinen Tabellenzugriff, sondern nur diesen eng
-- begrenzten, parameterisierten SECURITY-DEFINER-Guard.

CREATE OR REPLACE FUNCTION app.lock_matching_fido_mds_serial(expected_serial BIGINT)
RETURNS BOOLEAN
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT trust_state."blob_serial" = expected_serial
    FROM public."fido_mds_trust_state" AS trust_state
   WHERE trust_state."singleton" = TRUE
   FOR SHARE OF trust_state
$function$;

REVOKE ALL ON FUNCTION app.lock_matching_fido_mds_serial(BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.lock_matching_fido_mds_serial(BIGINT) FROM taxtronik_app;
GRANT EXECUTE ON FUNCTION app.lock_matching_fido_mds_serial(BIGINT) TO taxtronik_app;

COMMENT ON FUNCTION app.lock_matching_fido_mds_serial(BIGINT) IS
  'Hält den globalen FIDO-MDS-Anker bis Transaktionsende im SHARE-Lock und bestätigt ausschließlich eine exakt passende BLOB-Seriennummer.';
