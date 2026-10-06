CREATE OR REPLACE FUNCTION app.destroy_gwg_document_versions(p_document_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
DECLARE
  deleted_count INTEGER;
BEGIN
  PERFORM app.assert_gwg_document_destruction_due(p_document_id);
  PERFORM set_config('app.gwg_destroy_document_id', p_document_id::TEXT, TRUE);
  DELETE FROM public."document_version" WHERE "document_id" = p_document_id;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  UPDATE public."gwg_id_document" SET "document_id" = NULL
   WHERE "document_id" = p_document_id;
  UPDATE public."document"
     SET "title" = 'VERNICHTET',
         "mime_type" = 'application/x-destroyed',
         "deleted_at" = CURRENT_TIMESTAMP,
         "deleted_by_staff" = CASE
           WHEN app.current_actor_type() = 'STAFF' THEN app.current_actor_id()
           ELSE NULL
         END,
         "delete_reason" = 'GwG-Pflichtvernichtung nach Ablauf der Aufbewahrungsfrist',
         "gwg_destroyed_at" = CURRENT_TIMESTAMP,
         "gwg_destruction_error" = NULL,
         "shared_with_client_at" = NULL,
         "shared_by_staff" = NULL,
         "updated_at" = CURRENT_TIMESTAMP
   WHERE "id" = p_document_id;
  PERFORM set_config('app.gwg_destroy_document_id', '', TRUE);
  RETURN deleted_count;
END;
$function$;
