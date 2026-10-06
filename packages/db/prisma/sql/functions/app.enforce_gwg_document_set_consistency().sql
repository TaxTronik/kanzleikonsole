CREATE OR REPLACE FUNCTION app.enforce_gwg_document_set_consistency()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public."gwg_id_document" peer
     WHERE peer."document_set_id" = NEW."document_set_id"
       AND peer."id" <> NEW."id"
       AND (
         peer."gwg_check_id" IS DISTINCT FROM NEW."gwg_check_id"
         OR peer."type" IS DISTINCT FROM NEW."type"
         OR peer."owner_name" IS DISTINCT FROM NEW."owner_name"
         OR peer."natural_client_subject_id"
              IS DISTINCT FROM NEW."natural_client_subject_id"
         OR peer."beneficial_owner_subject_id"
              IS DISTINCT FROM NEW."beneficial_owner_subject_id"
         OR peer."representative_subject_id"
              IS DISTINCT FROM NEW."representative_subject_id"
         OR peer."number" IS DISTINCT FROM NEW."number"
         OR peer."issued_by" IS DISTINCT FROM NEW."issued_by"
         OR peer."issue_date" IS DISTINCT FROM NEW."issue_date"
         OR peer."expiry_date" IS DISTINCT FROM NEW."expiry_date"
         OR peer."verified_at" IS DISTINCT FROM NEW."verified_at"
         OR peer."identity_assignment_confirmed_at"
              IS DISTINCT FROM NEW."identity_assignment_confirmed_at"
         OR peer."identity_assignment_confirmed_by"
              IS DISTINCT FROM NEW."identity_assignment_confirmed_by"
       )
  ) THEN
    RAISE EXCEPTION 'Ein GwG-Dokumentset muss Check, Typ, Person und alle Ausweisdaten einheitlich abbilden.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$function$;
