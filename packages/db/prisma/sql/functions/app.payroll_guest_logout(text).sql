CREATE OR REPLACE FUNCTION app.payroll_guest_logout(p_session text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
 PERFORM app.payroll_assert_empty_context();
 IF p_session ~ '^[a-f0-9]{64}$' THEN UPDATE public.payroll_guest_session SET revoked_at=CURRENT_TIMESTAMP WHERE token_hash=p_session; END IF;
END $function$;
