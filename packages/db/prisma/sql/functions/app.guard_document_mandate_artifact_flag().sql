CREATE OR REPLACE FUNCTION app.guard_document_mandate_artifact_flag()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  RAISE EXCEPTION 'document.has_mandate_artifact kann nicht zurückgesetzt werden (P-01).'
    USING ERRCODE = 'restrict_violation';
END;
$function$;
