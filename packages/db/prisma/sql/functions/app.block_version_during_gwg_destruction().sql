CREATE OR REPLACE FUNCTION app.block_version_during_gwg_destruction()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
DECLARE
  old_document UUID;
  new_document UUID;
  target_document UUID;
  authorized_delete BOOLEAN := FALSE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_document := OLD."document_id";
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_document := NEW."document_id";
  END IF;
  target_document := COALESCE(new_document, old_document);

  PERFORM d."id"
    FROM public."document" d
   WHERE d."id" = old_document OR d."id" = new_document
   ORDER BY d."id"
   FOR UPDATE;

  IF TG_OP = 'DELETE' THEN
    authorized_delete := COALESCE((
      (
        current_setting('app.gwg_destroy_document_id', TRUE) = target_document::TEXT
        AND CURRENT_USER = (
          SELECT pg_get_userbyid(p.proowner)
            FROM pg_catalog.pg_proc p
           WHERE p.oid = pg_catalog.to_regprocedure('app.destroy_gwg_document_versions(uuid)')
        )
      ) OR (
        current_setting('app.gwg_discard_document_id', TRUE) = target_document::TEXT
        AND CURRENT_USER = (
          SELECT pg_get_userbyid(p.proowner)
            FROM pg_catalog.pg_proc p
           WHERE p.oid = pg_catalog.to_regprocedure(
             'app.discard_open_gwg_onboarding_document(uuid,uuid)'
           )
        )
      )
    ), FALSE);
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public."gwg_id_document" gid
      JOIN public."gwg_check" gc ON gc."id" = gid."gwg_check_id"
      JOIN public."tenant" t ON t."id" = gc."tenant_id"
     WHERE gid."document_id" = old_document OR gid."document_id" = new_document
  ) AND NOT authorized_delete THEN
    RAISE EXCEPTION 'Zugeordneter GwG-Beweisinhalt ist unveraenderlich; neues Dokument anlegen und erneut zuordnen.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public."document" d
     WHERE (d."id" = old_document OR d."id" = new_document)
       AND d."gwg_destruction_requested_at" IS NOT NULL
  ) AND NOT authorized_delete THEN
    RAISE EXCEPTION 'GwG-Dokument befindet sich in Vernichtung; neue Version nicht zulässig.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$function$;
