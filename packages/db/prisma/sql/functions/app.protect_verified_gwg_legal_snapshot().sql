CREATE OR REPLACE FUNCTION app.protect_verified_gwg_legal_snapshot()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
DECLARE
  authorized_check_destruction BOOLEAN := FALSE;
  authorized_grandfather_exit BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."destroyed_at" IS NOT NULL THEN
      RAISE EXCEPTION 'Neue GwG-Pruefung darf keinen Vernichtungsvermerk tragen.'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  authorized_check_destruction := COALESCE((
    current_setting('app.gwg_destroy_check_id', TRUE) = OLD."id"::TEXT
    AND CURRENT_USER = (
      SELECT pg_get_userbyid(p.proowner)
        FROM pg_catalog.pg_proc p
       WHERE p.oid = pg_catalog.to_regprocedure('app.destroy_gwg_check(uuid)')
    )
  ), FALSE);

  -- Trigger 00_gwg_check_identity_verification_guard setzt beim ersten
  -- Verlassen eines grandfathered VERIFIED-Checks das Cutover-Flag auf true.
  -- Genau diese irreversible Richtung ist Teil des gueltigen Statuswechsels.
  authorized_grandfather_exit :=
    OLD."status" = 'VERIFIED'
    AND NEW."status" <> 'VERIFIED'
    AND OLD."identity_assignment_required" = FALSE
    AND NEW."identity_assignment_required" = TRUE;

  -- to_jsonb umfasst bewusst auch alle 043-Felder. Ein vernichteter Check ist
  -- bis auf updated_at vollstaendig unveraenderlich.
  IF OLD."destroyed_at" IS NOT NULL
     AND (to_jsonb(NEW) - 'updated_at')
         IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at')
  THEN
    RAISE EXCEPTION 'Vernichteter GwG-Check ist bis auf updated_at unveraenderlich.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."destroyed_at" IS DISTINCT FROM OLD."destroyed_at"
     AND NOT authorized_check_destruction
  THEN
    RAISE EXCEPTION 'GwG-Vernichtungsvermerk darf nur kontrolliert gesetzt werden.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF (OLD."verified_at" IS NOT NULL OR OLD."status" = 'VERIFIED')
     AND (
       NEW."legal_form" IS DISTINCT FROM OLD."legal_form"
       OR NEW."register_number" IS DISTINCT FROM OLD."register_number"
       OR NEW."register_authority" IS DISTINCT FROM OLD."register_authority"
       OR NEW."no_register_entry" IS DISTINCT FROM OLD."no_register_entry"
       OR NEW."representative_names" IS DISTINCT FROM OLD."representative_names"
       OR NEW."ownership_structure_notes"
            IS DISTINCT FROM OLD."ownership_structure_notes"
       OR (
         NEW."identity_assignment_required"
           IS DISTINCT FROM OLD."identity_assignment_required"
         AND NOT authorized_grandfather_exit
       )
     )
     AND NOT authorized_check_destruction
  THEN
    RAISE EXCEPTION 'Einmal verifizierter GwG-Rechtstraeger-Snapshot ist unveraenderlich.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$function$;
