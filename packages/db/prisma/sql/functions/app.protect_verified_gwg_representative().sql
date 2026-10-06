CREATE OR REPLACE FUNCTION app.protect_verified_gwg_representative()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
DECLARE
  old_check_id UUID;
  new_check_id UUID;
  new_check_kind public."client_kind";
  authorized_check_destruction BOOLEAN := FALSE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_check_id := OLD."gwg_check_id";
    authorized_check_destruction := COALESCE((
      current_setting('app.gwg_destroy_check_id', TRUE) = old_check_id::TEXT
      AND CURRENT_USER = (
        SELECT pg_get_userbyid(p.proowner)
          FROM pg_catalog.pg_proc p
         WHERE p.oid = pg_catalog.to_regprocedure('app.destroy_gwg_check(uuid)')
      )
    ), FALSE);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_check_id := NEW."gwg_check_id";
  END IF;

  PERFORM gc."id"
    FROM public."gwg_check" gc
   WHERE gc."id" = old_check_id OR gc."id" = new_check_id
   ORDER BY gc."id"
   FOR SHARE;

  IF EXISTS (
    SELECT 1
      FROM public."gwg_check" gc
     WHERE gc."id" IN (old_check_id, new_check_id)
       AND EXISTS (
         SELECT 1 FROM public."tenant" t WHERE t."id" = gc."tenant_id"
       )
       AND (
         gc."verified_at" IS NOT NULL
         OR gc."status" = 'VERIFIED'
         OR gc."destroyed_at" IS NOT NULL
       )
  ) AND NOT authorized_check_destruction THEN
    RAISE EXCEPTION 'Einmal verifizierter GwG-Vertreter-Snapshot ist unveraenderlich.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP <> 'DELETE' THEN
    SELECT c."kind" INTO new_check_kind
      FROM public."gwg_check" gc
      JOIN public."client" c ON c."id" = gc."client_id"
     WHERE gc."id" = NEW."gwg_check_id";
    IF new_check_kind NOT IN ('JURPERS', 'PERSGES') THEN
      RAISE EXCEPTION 'Vertreter-Subjects sind nur fuer juristische Personen und Personengesellschaften zulaessig.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$;
