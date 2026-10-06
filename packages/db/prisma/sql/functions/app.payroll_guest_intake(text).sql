CREATE OR REPLACE FUNCTION app.payroll_guest_intake(p_session text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE pid UUID;
BEGIN
 PERFORM app.payroll_assert_empty_context();
 IF p_session !~ '^[a-f0-9]{64}$' THEN RETURN NULL; END IF;
 SELECT i.id INTO pid FROM public.payroll_guest_session s JOIN public.payroll_employee_invite v ON v.id=s.invite_id
 JOIN public.payroll_intake i ON i.id=v.intake_id JOIN public.client c ON c.id=i.client_id
 WHERE s.token_hash=p_session AND s.revoked_at IS NULL AND s.expires_at>CURRENT_TIMESTAMP
 AND v.revoked_at IS NULL AND v.expires_at>CURRENT_TIMESTAMP AND i.revoked_at IS NULL AND i.expires_at>CURRENT_TIMESTAMP
 AND c.allow_active AND c.mandate_ended_at IS NULL AND c.anonymized_at IS NULL
 AND EXISTS(SELECT 1 FROM public.tenant_setting t WHERE t.tenant_id=i.tenant_id AND t.key='modules' AND t.value->>'payrollIntake'='true')
 FOR SHARE OF s,v,i,c;
 RETURN pid;
END $function$;
