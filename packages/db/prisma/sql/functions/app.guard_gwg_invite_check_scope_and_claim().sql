CREATE OR REPLACE FUNCTION app.guard_gwg_invite_check_scope_and_claim()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
DECLARE
  old_check_id UUID;
  new_check_id UUID;
  authorized_revision_cutover BOOLEAN := FALSE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_check_id := OLD."gwg_check_id";
  END IF;
  new_check_id := NEW."gwg_check_id";

  -- FK-KeyShare kommt erst nach BEFORE-Triggern. Den Check deshalb hier
  -- selbst sperren und destroyed_at nach einem etwaigen Warten neu lesen.
  PERFORM gc."id"
    FROM public."gwg_check" gc
   WHERE gc."id" = old_check_id OR gc."id" = new_check_id
   ORDER BY gc."id"
   FOR SHARE;

  IF NEW."gwg_check_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public."gwg_check" gc
     WHERE gc."id" = NEW."gwg_check_id"
       AND gc."tenant_id" = NEW."tenant_id"
       AND gc."client_id" = NEW."client_id"
  ) THEN
    RAISE EXCEPTION 'GwG-Check gehoert nicht zu Tenant und Mandant der Einladung.'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NEW."gwg_check_id" IS NOT NULL
     AND (TG_OP = 'INSERT' OR new_check_id IS DISTINCT FROM old_check_id)
     AND EXISTS (
       SELECT 1 FROM public."gwg_check" gc
        WHERE gc."id" = new_check_id
          AND gc."destroyed_at" IS NOT NULL
     )
  THEN
    RAISE EXCEPTION 'Invite darf keinem vernichteten GwG-Check neu zugeordnet werden.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    authorized_revision_cutover := COALESCE((
      current_setting('app.gwg_invite_revision_cutover_id', TRUE) = OLD."id"::TEXT
      AND CURRENT_USER = (
        SELECT pg_get_userbyid(p.proowner)
          FROM pg_catalog.pg_proc p
         WHERE p.oid = pg_catalog.to_regprocedure(
           'app.cancel_legacy_gwg_invites_for_revision_cutover()'
         )
      )
      AND OLD."status" IN ('PENDING', 'STARTED')
      AND NEW."status" = 'CANCELLED'
      AND NEW."cancelled_at" IS NOT DISTINCT FROM
          COALESCE(OLD."cancelled_at", CURRENT_TIMESTAMP::TIMESTAMP(3))
      AND NEW."cancelled_by_staff" IS NULL
      AND NEW."token_hash" = ''
      AND (to_jsonb(NEW)
           - 'status' - 'cancelled_at' - 'cancelled_by_staff' - 'token_hash')
          IS NOT DISTINCT FROM
          (to_jsonb(OLD)
           - 'status' - 'cancelled_at' - 'cancelled_by_staff' - 'token_hash')
    ), FALSE);
  END IF;

  IF TG_OP = 'UPDATE' AND EXISTS (
    SELECT 1 FROM public."document" d
     WHERE d."gwg_onboarding_invite_id" = OLD."id"
       AND d."gwg_destruction_requested_at" IS NOT NULL
       AND d."gwg_destroyed_at" IS NULL
  ) AND (
    NEW."status" IS DISTINCT FROM OLD."status"
    OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
    OR NEW."gwg_check_id" IS DISTINCT FROM OLD."gwg_check_id"
    OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NEW."client_id" IS DISTINCT FROM OLD."client_id"
  ) AND NOT authorized_revision_cutover THEN
    RAISE EXCEPTION 'GwG-Invite ist durch einen Vernichtungsclaim eingefroren.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD."gwg_check_id" IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public."gwg_check" gc
        WHERE gc."id" = OLD."gwg_check_id"
          AND gc."destroyed_at" IS NOT NULL
     )
     AND (to_jsonb(NEW) - 'updated_at')
         IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at')
  THEN
    RAISE EXCEPTION 'Invite eines vernichteten GwG-Checks ist bis auf updated_at unveraenderlich.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$function$;
