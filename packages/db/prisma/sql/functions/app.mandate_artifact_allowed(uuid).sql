CREATE OR REPLACE FUNCTION app.mandate_artifact_allowed(aid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
 SELECT EXISTS(SELECT 1 FROM mandate_artifact a WHERE a.id=aid AND app.mandate_artifact_row_allowed(a.tenant_id,a.client_id,a.kind,a.structure_version_id,a.requires_payroll_access))
$function$;
