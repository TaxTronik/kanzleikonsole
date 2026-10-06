CREATE OR REPLACE FUNCTION app.freeze_gwg_claim_references()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
BEGIN
  IF TG_TABLE_NAME = 'client' THEN
    IF (
      NEW."mandate_ended_at" IS DISTINCT FROM OLD."mandate_ended_at"
      OR (OLD."allow_active" = FALSE AND NEW."allow_active" = TRUE)
    ) AND EXISTS (
      SELECT 1 FROM "document" d
       WHERE d."client_id" = OLD."id"
         AND d."gwg_destruction_requested_at" IS NOT NULL
         AND d."gwg_destroyed_at" IS NULL
    ) THEN
      RAISE EXCEPTION 'Mandant ist durch einen laufenden GwG-Vernichtungsclaim eingefroren.'
        USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'gwg_check' THEN
    IF (
      NEW."client_id" IS DISTINCT FROM OLD."client_id"
      OR NEW."destroyed_at" IS DISTINCT FROM OLD."destroyed_at"
      OR (
        NEW."status" IS DISTINCT FROM OLD."status"
        AND NOT (OLD."status" = 'VERIFIED' AND NEW."status" = 'EXPIRED')
      )
      OR NEW."verified_at" IS DISTINCT FROM OLD."verified_at"
    ) AND EXISTS (
      SELECT 1 FROM "document" d
       WHERE d."gwg_destruction_requested_at" IS NOT NULL
         AND d."gwg_destroyed_at" IS NULL
         AND (
           d."gwg_onboarding_invite_id" IN (
             SELECT inv."id" FROM "gwg_onboarding_invite" inv
              WHERE inv."gwg_check_id" = OLD."id"
           )
           OR d."id" IN (
             SELECT gid."document_id" FROM "gwg_id_document" gid
              WHERE gid."gwg_check_id" = OLD."id" AND gid."document_id" IS NOT NULL
           )
         )
    ) THEN
      RAISE EXCEPTION 'GwG-Check ist durch einen laufenden Vernichtungsclaim eingefroren.'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
