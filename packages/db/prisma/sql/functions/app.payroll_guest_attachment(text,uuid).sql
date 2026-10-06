CREATE OR REPLACE FUNCTION app.payroll_guest_attachment(p_session text, p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE pid UUID; result JSONB;
BEGIN
 pid:=app.payroll_guest_intake(p_session); IF pid IS NULL THEN RETURN NULL; END IF;
 SELECT to_jsonb(a) INTO result FROM public.payroll_attachment a WHERE a.id=p_id AND a.intake_id=pid AND a.audience='EMPLOYEE';
 RETURN result;
END $function$;
