CREATE OR REPLACE FUNCTION app.payroll_capture_authorized_revision(pid uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
 IF NOT app.payroll_staff_intake(pid) AND NOT app.payroll_employer_access(pid) THEN RAISE EXCEPTION 'Payroll access denied'; END IF;
 PERFORM app.payroll_capture_revision(pid,app.current_actor_id(),app.current_actor_type());
END $function$;
