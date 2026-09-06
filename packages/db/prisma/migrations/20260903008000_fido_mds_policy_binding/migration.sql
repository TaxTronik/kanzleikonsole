-- Fachkatalog: ACCESS-TENANT-RLS-001
-- Bindet den globalen FIDO-MDS-Stand zusätzlich an eine monoton steigende
-- Deployment-Policy und den kanonischen Hash der AAGUID-Allowlist. Alte oder
-- abweichend konfigurierte Replicas können damit keinen WebAuthn-Commit mehr
-- gegen denselben MDS-Serial durchführen.

BEGIN;

ALTER TABLE public."fido_mds_trust_state"
  ADD COLUMN "policy_revision" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "policy_hash" VARCHAR(64) NOT NULL DEFAULT
    '0000000000000000000000000000000000000000000000000000000000000000',
  ADD CONSTRAINT "fido_mds_trust_state_policy_revision_check"
    CHECK ("policy_revision" >= 0),
  ADD CONSTRAINT "fido_mds_trust_state_policy_hash_check"
    CHECK ("policy_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE public."fido_mds_trust_state"
  DROP CONSTRAINT "fido_mds_trust_state_blob_serial_check",
  ADD CONSTRAINT "fido_mds_trust_state_blob_serial_check"
    CHECK ("blob_serial" >= 0);

ALTER TABLE public."fido_mds_trust_state"
  ALTER COLUMN "policy_revision" DROP DEFAULT,
  ALTER COLUMN "policy_hash" DROP DEFAULT;

REVOKE ALL ON TABLE public."fido_mds_trust_state" FROM PUBLIC;
REVOKE ALL ON TABLE public."fido_mds_trust_state" FROM taxtronik_app;

REVOKE ALL ON FUNCTION app.lock_matching_fido_mds_serial(BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.lock_matching_fido_mds_serial(BIGINT) FROM taxtronik_app;
DROP FUNCTION app.lock_matching_fido_mds_serial(BIGINT);

CREATE FUNCTION app.lock_matching_fido_mds_state(
  expected_serial BIGINT,
  expected_policy_revision BIGINT,
  expected_policy_hash TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT trust_state."blob_serial" = expected_serial
     AND trust_state."blob_serial" > 0
     AND trust_state."policy_revision" = expected_policy_revision
     AND trust_state."policy_hash" = expected_policy_hash
    FROM public."fido_mds_trust_state" AS trust_state
   WHERE trust_state."singleton" = TRUE
   FOR SHARE OF trust_state
$function$;

REVOKE ALL ON FUNCTION app.lock_matching_fido_mds_state(BIGINT, BIGINT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.lock_matching_fido_mds_state(BIGINT, BIGINT, TEXT)
  FROM taxtronik_app;
GRANT EXECUTE ON FUNCTION app.lock_matching_fido_mds_state(BIGINT, BIGINT, TEXT)
  TO taxtronik_app;

COMMENT ON FUNCTION app.lock_matching_fido_mds_state(BIGINT, BIGINT, TEXT) IS
  'Hält den globalen FIDO-MDS-Anker bis Transaktionsende im SHARE-Lock und bestätigt exakt BLOB-Serie, Policy-Revision und Policy-Hash.';

COMMIT;
