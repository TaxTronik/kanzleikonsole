CREATE OR REPLACE FUNCTION app.mandate_artifact_document_allowed(tid uuid, did text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
 SELECT tid = app.current_tenant_id() AND (
   NOT EXISTS (
     SELECT 1 FROM mandate_artifact
      WHERE tenant_id = tid
        AND document_id = app.canonical_uuid_or_null(did)
   )
   OR EXISTS (
     SELECT 1 FROM mandate_artifact
      WHERE tenant_id = tid
        AND document_id = app.canonical_uuid_or_null(did)
        AND app.mandate_artifact_allowed(id)
        AND app.mandate_artifact_sources_valid(id)
   )
 )
$function$;
