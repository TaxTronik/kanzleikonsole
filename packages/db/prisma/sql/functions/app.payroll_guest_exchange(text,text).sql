CREATE OR REPLACE FUNCTION app.payroll_guest_exchange(p_invite text, p_session text)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v public.payroll_employee_invite; expiry TIMESTAMPTZ;
BEGIN
 PERFORM app.payroll_assert_empty_context();
 IF p_invite !~ '^[a-f0-9]{64}$' OR p_session !~ '^[a-f0-9]{64}$' THEN RETURN NULL; END IF;
 SELECT x.* INTO v FROM public.payroll_employee_invite x JOIN public.payroll_intake i ON i.id=x.intake_id JOIN public.client c ON c.id=i.client_id
 WHERE x.token_hash=p_invite AND x.redeemed_at IS NULL AND x.revoked_at IS NULL AND x.expires_at>CURRENT_TIMESTAMP
 AND i.revoked_at IS NULL AND i.expires_at>CURRENT_TIMESTAMP AND c.allow_active AND c.mandate_ended_at IS NULL AND c.anonymized_at IS NULL
 AND EXISTS(SELECT 1 FROM public.tenant_setting t WHERE t.tenant_id=i.tenant_id AND t.key='modules' AND t.value->>'payrollIntake'='true')
 FOR UPDATE OF x;
 IF v.id IS NULL THEN RETURN NULL; END IF;
 expiry:=LEAST(v.expires_at,CURRENT_TIMESTAMP+INTERVAL '8 hours');
 UPDATE public.payroll_employee_invite SET redeemed_at=CURRENT_TIMESTAMP WHERE id=v.id;
 INSERT INTO public.payroll_guest_session(tenant_id,invite_id,token_hash,expires_at) VALUES(v.tenant_id,v.id,p_session,expiry);
 RETURN expiry;
END $function$;
