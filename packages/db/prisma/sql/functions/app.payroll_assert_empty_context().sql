CREATE OR REPLACE FUNCTION app.payroll_assert_empty_context()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
 IF app.current_tenant_id() IS DISTINCT FROM '00000000-0000-0000-0000-000000000000'::uuid OR app.current_actor_id() IS NOT NULL THEN RAISE EXCEPTION 'Invalid capability context'; END IF;
END $function$;
