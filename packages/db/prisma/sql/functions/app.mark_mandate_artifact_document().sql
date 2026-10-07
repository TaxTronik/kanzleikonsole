CREATE OR REPLACE FUNCTION app.mark_mandate_artifact_document()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
 SET row_security TO 'off'
AS $function$
BEGIN
  UPDATE public."document"
     SET "has_mandate_artifact" = TRUE
   WHERE "id" = NEW."document_id"
     AND NOT "has_mandate_artifact";
  RETURN NULL;
END;
$function$;
