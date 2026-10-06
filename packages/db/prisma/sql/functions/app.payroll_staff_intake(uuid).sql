CREATE OR REPLACE FUNCTION app.payroll_staff_intake(pid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
 SELECT EXISTS(SELECT 1 FROM public.payroll_intake i WHERE i.id=pid AND app.payroll_staff_access(i.tenant_id,i.client_id));
$function$;
