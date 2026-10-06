CREATE OR REPLACE FUNCTION app.document_payroll_scope_allowed(tid uuid, did text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
 SELECT tid = app.current_tenant_id() AND (
   NOT EXISTS (
     SELECT 1 FROM public.document d
      WHERE d.id = app.canonical_uuid_or_null(did)
        AND d.tenant_id = tid
        AND d.requires_payroll_access
   )
   OR app.current_actor_type() = 'SYSTEM'
   OR (
     app.current_actor_type() = 'STAFF'
     AND app.expansion_staff_permission(tid, app.current_actor_id(), 'PAYROLL_MANAGE')
   )
 )
$function$;
